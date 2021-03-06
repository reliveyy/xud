import assert from 'assert';
import http from 'http';
import { SwapClientType, SwapRole, SwapState } from '../constants/enums';
import { CurrencyInstance } from '../db/types';
import Logger from '../Logger';
import swapErrors from '../swaps/errors';
import SwapClient, {
  ChannelBalance,
  ClientStatus,
  PaymentState,
  WalletBalance,
  TradingLimits,
  SwapClientInfo,
  PaymentStatus,
} from '../swaps/SwapClient';
import { SwapDeal, CloseChannelParams, OpenChannelParams } from '../swaps/types';
import { UnitConverter } from '../utils/UnitConverter';
import errors, { errorCodes } from './errors';
import {
  ConnextErrorResponse,
  ConnextInitWalletResponse,
  ConnextConfigResponse,
  ConnextBalanceResponse,
  ConnextTransferResponse,
  ConnextClientConfig,
  ConnextInfo,
  ConnextVersion,
  TokenPaymentRequest,
  ConnextTransferStatus,
  ExpectedIncomingTransfer,
  ProvidePreimageEvent,
  TransferReceivedEvent,
} from './types';
import { parseResponseBody } from '../utils/utils';
import { Observable, fromEvent, from, combineLatest } from 'rxjs';
import { take, pluck, timeout, filter } from 'rxjs/operators';

const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

interface ConnextClient {
  on(event: 'preimage', listener: (preimageRequest: ProvidePreimageEvent) => void): void;
  on(event: 'transferReceived', listener: (transferReceivedRequest: TransferReceivedEvent) => void): void;
  on(event: 'htlcAccepted', listener: (rHash: string, amount: number, currency: string) => void): this;
  on(event: 'connectionVerified', listener: (swapClientInfo: SwapClientInfo) => void): this;
  once(event: 'initialized', listener: () => void): this;
  emit(event: 'htlcAccepted', rHash: string, amount: number, currency: string): boolean;
  emit(event: 'connectionVerified', swapClientInfo: SwapClientInfo): boolean;
  emit(event: 'initialized'): boolean;
  emit(event: 'preimage', preimageRequest: ProvidePreimageEvent): void;
  emit(event: 'transferReceived', transferReceivedRequest: TransferReceivedEvent): void;
}

/**
 * Waits for the preimage event from SwapClient for a specified hash
 * @param client the swap client instance to listen events from
 * @param expectedHash the expected hash of the payment
 * @param errorTimeout optional maximum duration of time to wait for the preimage
 */
const waitForPreimageByHash = (
  client: SwapClient,
  expectedHash: string,
  errorTimeout = 34000,
): Promise<string> => {
  // create an observable that emits values when a preimage
  // event is triggered on the client
  const preimage$: Observable<ProvidePreimageEvent> = fromEvent(client, 'preimage');
  const expectedPreimageReceived$ = preimage$.pipe(
    // filter out events that do not match our expected hash
    filter(preimageEvent => preimageEvent.rHash === expectedHash),
    // map the ProvidePreimageEvent object to a string as the consumer is
    // only interested in the value of the preimage
    pluck('preimage'),
    // complete the observable and clean up all the listeners
    // once we receive 1 event that matches our conditions
    take(1),
    // emit an error if the observable does not emit any values
    // for the specified duration
    timeout(errorTimeout),
  );
  // convert the observable to a promise that resolves on complete
  // and rejects on error
  return expectedPreimageReceived$.toPromise();
};

/**
 * A class representing a client to interact with connext.
 */
class ConnextClient extends SwapClient {
  public readonly type = SwapClientType.Connext;
  public readonly finalLock = 200;
  public address?: string;
  /** A map of currency symbols to token addresses. */
  public tokenAddresses = new Map<string, string>();
  /** A map of expected invoices by hash.
   * This is equivalent to invoices of lnd with the difference
   * being that we're managing the state of invoice on xud level.
   */
  private expectedIncomingTransfers = new Map<string, ExpectedIncomingTransfer>();
  private port: number;
  private host: string;
  private webhookport: number;
  private webhookhost: string;
  private unitConverter: UnitConverter;
  private seed: string | undefined;

  /**
   * Creates a connext client.
   */
  constructor({
    config,
    logger,
    unitConverter,
    currencyInstances,
  }: {
    unitConverter: UnitConverter;
    config: ConnextClientConfig;
    currencyInstances: CurrencyInstance[],
    logger: Logger;
  }) {
    super(logger, config.disable);

    this.port = config.port;
    this.host = config.host;
    this.webhookhost = config.webhookhost;
    this.webhookport = config.webhookport;
    this.unitConverter = unitConverter;
    this.setTokenAddresses(currencyInstances);
  }

  public get minutesPerBlock() {
    return 0.25; // 15 seconds per block target
  }

  public get label() {
    return 'Connext';
  }

  public initSpecific = async () => {
    this.on('transferReceived', this.onTransferReceived.bind(this));
  }

  private onTransferReceived = (transferReceivedRequest: TransferReceivedEvent) => {
    const {
      tokenAddress,
      units,
      timelock,
      rHash,
    } = transferReceivedRequest;
    const expectedIncomingTransfer = this.expectedIncomingTransfers.get(rHash);
    if (!expectedIncomingTransfer) {
      this.logger.warn(`received unexpected incoming transfer created event with rHash ${rHash}`);
      return;
    }
    const {
      units: expectedUnits,
      expiry: expectedTimelock,
      tokenAddress: expectedTokenAddress,
    } = expectedIncomingTransfer;
    const currency = this.getCurrencyByTokenaddress(tokenAddress);
    if (
      tokenAddress === expectedTokenAddress &&
      units === expectedUnits &&
      timelock === expectedTimelock
    ) {
      this.logger.debug(`accepting incoming transfer with rHash: ${rHash}, units: ${units}, timelock ${timelock} and currency ${currency}`);
      this.emit('htlcAccepted', rHash, units, currency);
      this.expectedIncomingTransfers.delete(rHash);
    }
  }

  // TODO: Ideally, this would be set in the constructor.
  // Related issue: https://github.com/ExchangeUnion/xud/issues/1494
  public setSeed = (seed: string) => {
    this.seed = seed;
  }

  /**
   * Initiates wallet for the Connext client
   */
  public initWallet = async (seedMnemonic: string) => {
    const res = await this.sendRequest('/mnemonic', 'POST', { mnemonic: seedMnemonic });
    return await parseResponseBody<ConnextInitWalletResponse>(res);
  }

  public initConnextClient = async () => {
    const res = await this.sendRequest('/connect', 'POST');
    return await parseResponseBody<ConnextConfigResponse>(res);
  }

  private subscribePreimage = async () => {
    await this.sendRequest('/subscribe', 'POST', {
      event: 'CONDITIONAL_TRANSFER_UNLOCKED_EVENT',
      webhook: `http://${this.webhookhost}:${this.webhookport}/preimage`,
    });
  }

  private subscribeIncomingTransfer = async () => {
    await this.sendRequest('/subscribe', 'POST', {
      event: 'CONDITIONAL_TRANSFER_CREATED_EVENT',
      webhook: `http://${this.webhookhost}:${this.webhookport}/incoming-transfer`,
    });
  }

  /**
   * Associate connext with currencies that have a token address
   */
  private setTokenAddresses = (currencyInstances: CurrencyInstance[]) => {
    currencyInstances.forEach((currency) => {
      if (currency.tokenAddress && currency.swapClient === SwapClientType.Connext) {
        this.tokenAddresses.set(currency.id, currency.tokenAddress);
      }
    });
  }

  public totalOutboundAmount = (): number => {
    // assume MAX_AMOUNT since Connext will re-collaterize accordingly
    return MAX_AMOUNT;
  }

  public maxChannelOutboundAmount = (): number => {
    // assume MAX_AMOUNT since Connext will re-collaterize accordingly
    return MAX_AMOUNT;
  }

  public maxChannelInboundAmount = (): number => {
    // assume MAX_AMOUNT since Connext will re-collaterize accordingly
    return MAX_AMOUNT;
  }

  protected updateCapacity = async () => {
    try {
      const channelBalancePromises = [];
      for (const [currency] of this.tokenAddresses) {
        channelBalancePromises.push(this.channelBalance(currency));
      }
      await Promise.all(channelBalancePromises);
    } catch (e) {
      this.logger.error('failed to update total outbound capacity', e);
    }
  }

  protected getTokenAddress(currency: string): string {
    const tokenAdress = this.tokenAddresses.get(currency);
    if (!tokenAdress) {
      throw errors.TOKEN_ADDRESS_NOT_FOUND;
    }
    return tokenAdress;
  }

  protected getCurrencyByTokenaddress(tokenAddress: string): string {
    let currency;
    for (const [key, value] of this.tokenAddresses.entries()) {
      if (value === tokenAddress) {
        currency = key;
      }
    }
    if (!currency) {
      throw errors.CURRENCY_NOT_FOUND_BY_TOKENADDRESS(tokenAddress);
    }
    return currency;
  }

  protected verifyConnection = async () => {
    this.logger.info('trying to verify connection to connext');
    try {
      if (!this.seed) {
        throw errors.MISSING_SEED;
      }
      await this.sendRequest('/health', 'GET');
      await this.initWallet(this.seed);
      const config = await this.initConnextClient();
      await this.subscribePreimage();
      await this.subscribeIncomingTransfer();
      const { userIdentifier } = config;
      this.emit('connectionVerified', {
        newIdentifier: userIdentifier,
      });
      this.setStatus(ClientStatus.ConnectionVerified);
    } catch (err) {
      this.logger.error(
        `could not verify connection to connext, retrying in ${ConnextClient.RECONNECT_INTERVAL} ms`,
        err,
      );
      await this.disconnect();
    }
  }

  public sendSmallestAmount = async (
    rHash: string,
    destination: string,
    currency: string,
  ) => {
    const tokenAddress = this.getTokenAddress(currency);

    const secret = await this.executeHashLockTransfer({
      amount: '1',
      assetId: tokenAddress,
      lockHash: rHash,
      timelock: this.finalLock.toString(),
      recipient: destination,
    });
    return secret;
  }

  public sendPayment = async (deal: SwapDeal): Promise<string> => {
    assert(deal.state === SwapState.Active);
    assert(deal.destination);
    let amount: string;
    let tokenAddress: string;
    let lockTimeout: number | undefined;
    try {
      let secret;
      if (deal.role === SwapRole.Maker) {
        // we are the maker paying the taker
        amount = BigInt(deal.takerUnits).toString();
        tokenAddress = this.tokenAddresses.get(deal.takerCurrency)!;
        const executeTransfer = this.executeHashLockTransfer({
          amount,
          assetId: tokenAddress,
          timelock: deal.takerCltvDelta.toString(),
          lockHash: `0x${deal.rHash}`,
          recipient: deal.destination,
        });
        // @ts-ignore
        const [executeTransferResponse, preimage] = await Promise.all([
          executeTransfer,
          waitForPreimageByHash(this, deal.rHash),
        ]);
        secret = preimage;
      } else {
        // we are the taker paying the maker
        amount = BigInt(deal.makerUnits).toString();
        tokenAddress = this.tokenAddresses.get(deal.makerCurrency)!;
        lockTimeout = deal.makerCltvDelta!;
        secret = deal.rPreimage!;
        const executeTransfer = this.executeHashLockTransfer({
          amount,
          assetId: tokenAddress,
          timelock: lockTimeout.toString(),
          lockHash: `0x${deal.rHash}`,
          recipient: deal.destination,
        });
        await executeTransfer;
      }
      return secret;
    } catch (err) {
      switch (err.code) {
        case 'ECONNRESET':
        case errorCodes.UNEXPECTED:
        case errorCodes.TIMEOUT:
        case errorCodes.SERVER_ERROR:
        case errorCodes.INVALID_TOKEN_PAYMENT_RESPONSE:
        default:
          throw swapErrors.UNKNOWN_PAYMENT_ERROR(err.message);
      }
    }
  }

  public addInvoice = async (
    { rHash: expectedHash, units: expectedUnits, expiry: expectedTimelock, currency: expectedCurrency }:
    { rHash: string, units: number, expiry?: number, currency?: string },
  ) => {
    if (!expectedCurrency) {
      throw errors.CURRENCY_MISSING;
    }
    if (!expectedTimelock) {
      throw errors.EXPIRY_MISSING;
    }
    const expectedTokenAddress = this.getTokenAddress(expectedCurrency);
    const expectedIncomingTransfer: ExpectedIncomingTransfer = {
      rHash: expectedHash,
      units: expectedUnits,
      expiry: expectedTimelock,
      tokenAddress: expectedTokenAddress,
    };
    this.expectedIncomingTransfers.set(expectedHash, expectedIncomingTransfer);
  }

  /**
   * Resolve a HashLock Transfer on the Connext network.
   */
  public settleInvoice = async (_rHash: string, rPreimage: string, currency: string) => {
    const assetId = this.tokenAddresses.get(currency);
    await this.sendRequest('/hashlock-resolve', 'POST', {
      assetId,
      preImage: `0x${rPreimage}`,
    });
  }

  public removeInvoice = async (rHash: string) => {
    this.expectedIncomingTransfers.delete(rHash);
  }

  private async getHashLockStatus(lockHash: string, assetId: string) {
    const res = await this.sendRequest(`/hashlock-status/0x${lockHash}/${assetId}`, 'GET');
    const transferStatusResponse = await parseResponseBody<ConnextTransferStatus>(res);
    return transferStatusResponse;
  }

  public lookupPayment = async (rHash: string, currency: string): Promise<PaymentStatus> => {
    try {
      const assetId = this.getTokenAddress(currency);
      const transferStatusResponse = await this.getHashLockStatus(rHash, assetId);
      // TODO: Edge case. Once https://github.com/connext/rest-api-client/issues/31 is
      // implemented check for the response code 404 and set the payment as failed.

      switch (transferStatusResponse.status) {
        case 'PENDING':
          return { state: PaymentState.Pending };
        case 'COMPLETED':
          return {
            state: PaymentState.Succeeded,
            preimage: transferStatusResponse.preImage?.slice(2),
          };
        case 'EXPIRED':
        case 'FAILED':
          return { state: PaymentState.Failed };
        default:
          return { state: PaymentState.Pending };
      }
    } catch (e) {
      this.logger.error(e);
      throw errors.SERVER_ERROR;
    }
  }

  public getRoute = async () => {
    /** A placeholder route value that assumes a fixed lock time of 100 for Connext. */
    return {
      getTotalTimeLock: () => 101,
    };
  }

  public canRouteToNode = async () => {
    return true;
  }

  public getHeight = async () => {
    return 1; // connext's API does not tell us the height
  }

  public getInfo = async (): Promise<ConnextInfo> => {
    let address: string | undefined;
    let version: string | undefined;
    let status = errors.CONNEXT_CLIENT_NOT_INITIALIZED.message;
    if (this.isDisabled()) {
      status = errors.CONNEXT_IS_DISABLED.message;
    } else {
      try {
        const getInfo$ = combineLatest(
          from(this.getVersion()),
          from(this.getClientConfig()),
        ).pipe(
          // error if no response within 5000 ms
          timeout(5000),
          // complete the stream when we receive 1 value
          take(1),
        );
        const [streamVersion, clientConfig] = await getInfo$.toPromise();
        status = 'Ready';
        version = streamVersion;
        address = clientConfig.signerAddress;
      } catch (err) {
        status = err.message;
      }
    }

    return { status, address, version };
  }

  /**
   * Gets the connext version.
   */
  public getVersion = async (): Promise<string> => {
    const res = await this.sendRequest('/version', 'GET');
    const { version } = await parseResponseBody<ConnextVersion>(res);
    return version;
  }

  /**
   * Gets the configuration of Connext client.
   */
  public getClientConfig = async (): Promise<ConnextConfigResponse> => {
    const res = await this.sendRequest('/config', 'GET');
    const clientConfig = await parseResponseBody<ConnextConfigResponse>(res);
    return clientConfig;
  }

  public channelBalance = async (
    currency?: string,
  ): Promise<ChannelBalance> => {
    if (!currency) {
      return { balance: 0, pendingOpenBalance: 0, inactiveBalance: 0 };
    }

    const { freeBalanceOffChain } = await this.getBalance(currency);

    const freeBalanceAmount = this.unitConverter.unitsToAmount({
      currency,
      units: Number(freeBalanceOffChain),
    });

    return {
      balance: freeBalanceAmount,
      inactiveBalance: 0,
      pendingOpenBalance: 0,
    };
  }

  public tradingLimits = async (): Promise<TradingLimits> => {
    // assume MAX_AMOUNT since Connext will re-collaterize accordingly
    return {
      maxSell: MAX_AMOUNT,
      maxBuy: MAX_AMOUNT,
    };
  }

  /**
   * Returns the balances available in wallet for a specified currency.
   */
  public walletBalance = async (
    currency?: string,
  ): Promise<WalletBalance> => {
    if (!currency) {
      return {
        totalBalance: 0,
        confirmedBalance: 0,
        unconfirmedBalance: 0,
      };
    }

    const { freeBalanceOnChain } = await this.getBalance(currency);

    const confirmedBalanceAmount = this.unitConverter.unitsToAmount({
      currency,
      units: Number(freeBalanceOnChain),
    });

    return {
      totalBalance: confirmedBalanceAmount,
      confirmedBalance: confirmedBalanceAmount,
      unconfirmedBalance: 0,
    };
  }

  private getBalance = async (currency: string) => {
    const tokenAddress = this.getTokenAddress(currency);
    const res = await this.sendRequest(`/balance/${tokenAddress}`, 'GET');
    const balance = await parseResponseBody<ConnextBalanceResponse>(res);
    return balance;
  }

  public deposit = async () => {
    const clientConfig = await this.getClientConfig();
    return clientConfig.signerAddress;
  }

  public openChannel = async ({ currency, units }: OpenChannelParams) => {
    if (!currency) {
      throw errors.CURRENCY_MISSING;
    }
    const assetId = this.getTokenAddress(currency);
    await this.sendRequest('/deposit', 'POST', {
      assetId,
      amount: BigInt(units).toString(),
    });
  }

  public closeChannel = async ({ units, currency, destination }: CloseChannelParams): Promise<void> => {
    if (!currency) {
      throw errors.CURRENCY_MISSING;
    }
    const amount = units || (await this.getBalance(currency)).freeBalanceOffChain;

    await this.sendRequest('/withdraw', 'POST', {
      recipient: destination,
      amount: BigInt(amount).toString(),
      assetId: this.tokenAddresses.get(currency),
    });
  }

  /**
   * Create a HashLock Transfer on the Connext network.
   * @param targetAddress recipient of the payment
   * @param tokenAddress contract address of the token
   * @param amount
   * @param lockHash
   */
  private executeHashLockTransfer = async (payload: TokenPaymentRequest): Promise<string> => {
    this.logger.debug(`sending payment of ${payload.amount} with hash ${payload.lockHash} to ${payload.recipient}`);
    const res = await this.sendRequest('/hashlock-transfer', 'POST', payload);
    const { appId } = await parseResponseBody<ConnextTransferResponse>(res);
    return appId;
  }

  /**
   * Deposits more of a token to an existing client.
   * @param multisigAddress the address of the client to deposit to
   * @param balance the amount to deposit to the client
   */
  public depositToChannel = async (
    assetId: string,
    amount: number,
  ): Promise<void> => {
    await this.sendRequest('/hashlock-transfer', 'POST', {
      assetId,
      amount: BigInt(amount).toString(),
    });
  }

  /** Connext client specific cleanup. */
  protected disconnect = async () => {
    this.setStatus(ClientStatus.Disconnected);
  }

  /**
   * Sends a request to the Connext REST API.
   * @param endpoint the URL endpoint
   * @param method an HTTP request method
   * @param payload the request payload
   */
  private sendRequest = (endpoint: string, method: string, payload?: object): Promise<http.IncomingMessage> => {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        method,
        hostname: this.host,
        port: this.port,
        path: `${endpoint}`,
      };

      let payloadStr: string | undefined;
      if (payload) {
        payloadStr = JSON.stringify(payload);
        options.headers = {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
        };
      }

      this.logger.trace(`sending request to ${endpoint}: ${payloadStr}`);
      const req = http.request(options, async (res) => {
        switch (res.statusCode) {
          case 200:
          case 201:
          case 204:
            resolve(res);
            break;
          case 402:
            reject(errors.INSUFFICIENT_BALANCE);
            break;
          case 408:
            reject(errors.TIMEOUT);
            break;
          case 409:
            const body = await parseResponseBody<ConnextErrorResponse>(res);
            reject(body.message);
            break;
          case 500:
            this.logger.error(`connext server error ${res.statusCode}: ${res.statusMessage}`);
            reject(errors.SERVER_ERROR);
            break;
          default:
            this.logger.error(`unexpected connext status ${res.statusCode}: ${res.statusMessage}`);
            reject(errors.UNEXPECTED);
            break;
        }
      });

      req.on('error', async (err: any) => {
        if (err.code === 'ECONNREFUSED') {
          await this.disconnect();
        }
        this.logger.error(err);
        reject(err);
      });

      if (payloadStr) {
        req.write(payloadStr);
      }
      req.end();
    });
  }
}

export default ConnextClient;
