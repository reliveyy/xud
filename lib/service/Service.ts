import { ProvidePreimageEvent, TransferReceivedEvent } from '../connextclient/types';
import { OrderSide, Owner, SwapClientType, SwapRole } from '../constants/enums';
import { OrderAttributes, TradeInstance } from '../db/types';
import Logger from '../Logger';
import OrderBook from '../orderbook/OrderBook';
import { Currency, isOwnOrder, Order, OrderPortion, OwnLimitOrder, OwnMarketOrder, PlaceOrderEvent } from '../orderbook/types';
import Pool from '../p2p/Pool';
import swapsErrors from '../swaps/errors';
import { TradingLimits } from '../swaps/SwapClient';
import SwapClientManager from '../swaps/SwapClientManager';
import Swaps from '../swaps/Swaps';
import { ResolveRequest, SwapFailure, SwapSuccess } from '../swaps/types';
import { isNodePubKey } from '../utils/aliasUtils';
import { parseUri, toUri, UriParts } from '../utils/uriUtils';
import { checkDecimalPlaces, sortOrders, toEip55Address } from '../utils/utils';
import commitHash from '../Version';
import errors from './errors';
import { NodeIdentifier, ServiceComponents, ServiceOrder, ServiceOrderSidesArrays, ServicePlaceOrderEvent, ServiceTrade, XudInfo } from './types';

/** Functions to check argument validity and throw [[INVALID_ARGUMENT]] when invalid. */
const argChecks = {
  HAS_HOST: ({ host }: { host: string }) => { if (host === '') throw errors.INVALID_ARGUMENT('host must be specified'); },
  HAS_ORDER_ID: ({ orderId }: { orderId: string }) => { if (orderId === '') throw errors.INVALID_ARGUMENT('orderId must be specified'); },
  HAS_NODE_PUB_KEY: ({ nodePubKey }: { nodePubKey: string }) => {
    if (nodePubKey === '') throw errors.INVALID_ARGUMENT('nodePubKey must be specified');
  },
  HAS_NODE_IDENTIFIER: ({ nodeIdentifier }: { nodeIdentifier: string }) => {
    if (nodeIdentifier === '') throw errors.INVALID_ARGUMENT('peerPubKey or alias must be specified');
  },
  HAS_PAIR_ID: ({ pairId }: { pairId: string }) => { if (pairId === '') throw errors.INVALID_ARGUMENT('pairId must be specified'); },
  HAS_RHASH: ({ rHash }: { rHash: string }) => { if (rHash === '') throw errors.INVALID_ARGUMENT('rHash must be specified'); },
  POSITIVE_AMOUNT: ({ amount }: { amount: number }) => { if (amount <= 0) throw errors.INVALID_ARGUMENT('amount must be greater than 0'); },
  POSITIVE_QUANTITY: ({ quantity }: { quantity: number }) => { if (quantity <= 0) throw errors.INVALID_ARGUMENT('quantity must be greater than 0'); },
  PRICE_NON_NEGATIVE: ({ price }: { price: number }) => { if (price < 0) throw errors.INVALID_ARGUMENT('price cannot be negative'); },
  PRICE_MAX_DECIMAL_PLACES: ({ price }: { price: number }) => {
    if (checkDecimalPlaces(price)) throw errors.INVALID_ARGUMENT('price cannot have more than 12 decimal places');
  },
  VALID_CURRENCY: ({ currency }: { currency: string }) => {
    if (currency.length < 2 || currency.length > 5 || !currency.match(/^[A-Z0-9]+$/)) {
      throw errors.INVALID_ARGUMENT('currency must consist of 2 to 5 upper case English letters or numbers');
    }
  },
  VALID_PORT: ({ port }: { port: number }) => {
    if (port < 1024 || port > 65535 || !Number.isInteger(port)) throw errors.INVALID_ARGUMENT('port must be an integer between 1024 and 65535');
  },
  VALID_SWAP_CLIENT: ({ swapClient }: { swapClient: number }) => {
    if (!SwapClientType[swapClient]) throw errors.INVALID_ARGUMENT('swap client is not recognized');
  },
};

/** A class containing the available RPC methods for an unlocked, running instance of xud. */
class Service {
  public shutdown: () => void;
  /** Whether the service is disabled - in other words whether xud is locked. */
  public disabled = false;
  private orderBook: OrderBook;
  private swapClientManager: SwapClientManager;
  private pool: Pool;
  private version: string;
  private swaps: Swaps;
  private logger: Logger;

  /** Create an instance of available RPC methods and bind all exposed functions. */
  constructor(components: ServiceComponents) {
    this.shutdown = components.shutdown;
    this.orderBook = components.orderBook;
    this.swapClientManager = components.swapClientManager;
    this.pool = components.pool;
    this.swaps = components.swaps;
    this.logger = components.logger;

    this.version = components.version;
  }

  /** Adds a currency. */
  public addCurrency = async (args: { currency: string, swapClient: SwapClientType | number, decimalPlaces: number, tokenAddress?: string }) => {
    argChecks.VALID_CURRENCY(args);
    argChecks.VALID_SWAP_CLIENT(args);
    const { currency, swapClient, tokenAddress, decimalPlaces } = args;

    let address = tokenAddress;
    if (args.swapClient === SwapClientType.Raiden && address) {
      address = toEip55Address(address);
    }

    await this.orderBook.addCurrency({
      swapClient,
      decimalPlaces,
      id: currency,
      tokenAddress: address,
    });
  }

  /** Adds a trading pair. */
  public addPair = async (args: { baseCurrency: string, quoteCurrency: string }) => {
    await this.orderBook.addPair(args);
  }

  /*
   * Remove placed order from the orderbook.
   */
  public removeOrder = (args: { orderId: string, quantity?: number }) => {
    const { orderId, quantity } = args;
    argChecks.HAS_ORDER_ID(args);

    return this.orderBook.removeOwnOrderByLocalId(orderId, true, quantity);
  }

  /** Gets the total lightning network balance for a given currency. */
  public getBalance = async (args: { currency: string }) => {
    const { currency } = args;
    const channelBalances = new Map<string, { balance: number, pendingOpenBalance: number, inactiveBalance: number }>();
    const walletBalances = new Map<string, { confirmedBalance: number, unconfirmedBalance: number }>();

    if (currency) {
      argChecks.VALID_CURRENCY(args);

      const swapClient = this.swapClientManager.get(currency.toUpperCase());
      if (swapClient) {
        const channelBalance = await swapClient.channelBalance(currency);
        channelBalances.set(currency, channelBalance);
        const walletBalance = await swapClient.walletBalance(currency);
        walletBalances.set(currency, walletBalance);
      } else {
        throw swapsErrors.SWAP_CLIENT_NOT_FOUND(currency);
      }
    } else {
      const balancePromises: Promise<any>[] = [];
      this.swapClientManager.swapClients.forEach((swapClient, currency) => {
        if (swapClient.isConnected()) {
          balancePromises.push(swapClient.channelBalance(currency).then((channelBalance) => {
            channelBalances.set(currency, channelBalance);
          }));
          balancePromises.push(swapClient.walletBalance(currency).then((walletBalance) => {
            walletBalances.set(currency, walletBalance);
          }));
        }
      });
      await Promise.all(balancePromises);
    }
    const balances = new Map<string, {
      channelBalance: number, pendingChannelBalance: number, inactiveChannelBalance: number,
      walletBalance: number, unconfirmedWalletBalance: number,
      totalBalance: number,
    }>();
    channelBalances.forEach((channelBalance, currency) => {
      const walletBalance = walletBalances.get(currency) as { confirmedBalance: number, unconfirmedBalance: number };
      const totalBalance = channelBalance.balance + channelBalance.pendingOpenBalance + channelBalance.inactiveBalance +
        walletBalance.confirmedBalance + walletBalance.unconfirmedBalance;
      balances.set(
        currency,
        {
          totalBalance,
          channelBalance: channelBalance.balance,
          pendingChannelBalance: channelBalance.pendingOpenBalance,
          inactiveChannelBalance: channelBalance.inactiveBalance,
          walletBalance: walletBalance.confirmedBalance,
          unconfirmedWalletBalance: walletBalance.unconfirmedBalance,
        });
    });
    return balances;
  }

  /** Gets the trading limits (max outbound and inbound capacities for a distinct channel) for a given currency. */
  public tradingLimits = async (args: { currency: string }) => {
    const { currency } = args;
    const tradingLimitsMap = new Map<string, TradingLimits>();

    if (currency) {
      argChecks.VALID_CURRENCY(args);

      const swapClient = this.swapClientManager.get(currency.toUpperCase());
      if (swapClient) {
        const tradingLimits = await swapClient.tradingLimits(currency);
        tradingLimitsMap.set(currency, tradingLimits);
      } else {
        throw swapsErrors.SWAP_CLIENT_NOT_FOUND(currency);
      }
    } else {
      const promises: Promise<any>[] = [];
      this.swapClientManager.swapClients.forEach((swapClient, currency) => {
        if (swapClient.isConnected()) {
          promises.push(swapClient.tradingLimits(currency).then((tradingLimits) => {
            tradingLimitsMap.set(currency, tradingLimits);
          }));
        }
      });
      await Promise.all(promises);
    }

    return tradingLimitsMap;
  }

  /**
   * Connect to an XU node on a given node uri.
   */
  public connect = async (args: { nodeUri: string, retryConnecting: boolean }) => {
    const { nodeUri, retryConnecting } = args;

    let uriParts: UriParts;
    try {
      uriParts = parseUri(nodeUri);
    } catch (err) {
      throw errors.INVALID_ARGUMENT('uri is invalid');
    }
    const { nodePubKey, host, port } = uriParts;
    argChecks.HAS_NODE_PUB_KEY({ nodePubKey });
    argChecks.HAS_HOST({ host });
    argChecks.VALID_PORT({ port });

    await this.pool.addOutbound({ host, port }, nodePubKey, retryConnecting, true);
  }

  public walletDeposit = async (args: { currency: string }) => {
    const { currency } = args;
    const address = await this.swapClientManager.deposit(currency);
    return address;
  }

  public walletWithdraw = async (args: { currency: string, amount: number, destination: string, all: boolean, fee: number}) => {
    const txId = await this.swapClientManager.withdraw(args);
    return txId;
  }

  /*
   * Closes any payment channels for a specified node and currency.
   */
  public closeChannel = async (
    args: { nodeIdentifier: string, currency: string, force: boolean, destination: string, amount: number },
  ) => {
    const { nodeIdentifier, currency, force, destination, amount } = args;
    argChecks.VALID_CURRENCY({ currency });

    let remoteIdentifier: string | undefined;
    if (nodeIdentifier) {
      const nodePubKey = isNodePubKey(nodeIdentifier) ? nodeIdentifier : this.pool.resolveAlias(nodeIdentifier);
      const swapClientType = this.swapClientManager.getType(currency);
      if (swapClientType === undefined) {
        throw swapsErrors.SWAP_CLIENT_NOT_FOUND(currency);
      }
      const peer = this.pool.getPeer(nodePubKey);
      remoteIdentifier = peer.getIdentifier(swapClientType, currency);
    }

    await this.swapClientManager.closeChannel({
      currency,
      force,
      destination,
      amount,
      remoteIdentifier,
    });
  }

  /*
   * Opens a payment channel to a specified node, currency and amount.
   */
  public openChannel = async (
    args: { nodeIdentifier: string, amount: number, currency: string, pushAmount?: number },
  ) => {
    const { nodeIdentifier, amount, currency, pushAmount } = args;
    argChecks.POSITIVE_AMOUNT({ amount });
    argChecks.VALID_CURRENCY({ currency });

    let remoteIdentifier: string | undefined;
    let uris: string[] | undefined;

    try {
      if (nodeIdentifier) {
        const nodePubKey = isNodePubKey(nodeIdentifier) ? nodeIdentifier : this.pool.resolveAlias(nodeIdentifier);
        const swapClientType = this.swapClientManager.getType(currency);
        if (swapClientType === undefined) {
          throw swapsErrors.SWAP_CLIENT_NOT_FOUND(currency);
        }
        const peer = this.pool.getPeer(nodePubKey);
        remoteIdentifier = peer.getIdentifier(swapClientType, currency);
        if (swapClientType === SwapClientType.Lnd) {
          uris = peer.getLndUris(currency);
        }
      }

      await this.swapClientManager.openChannel({
        remoteIdentifier,
        uris,
        amount,
        currency,
        pushAmount,
      });
    } catch (e) {
      const errorMessage = e.message || 'unknown';
      throw errors.OPEN_CHANNEL_FAILURE(currency, nodeIdentifier, amount, errorMessage);
    }
  }

  /*
   * Ban a XU node manually and disconnect from it.
   */
  public ban = async (args: { nodeIdentifier: string }) => {
    argChecks.HAS_NODE_IDENTIFIER(args);
    const nodePubKey = isNodePubKey(args.nodeIdentifier) ? args.nodeIdentifier : this.pool.resolveAlias(args.nodeIdentifier);
    await this.pool.banNode(nodePubKey);
  }

  /*
   * Remove ban from XU node manually and connenct to it.
   */
  public unban = async (args: { nodeIdentifier: string, reconnect: boolean }) => {
    argChecks.HAS_NODE_IDENTIFIER(args);
    const nodePubKey = isNodePubKey(args.nodeIdentifier) ? args.nodeIdentifier : this.pool.resolveAlias(args.nodeIdentifier);
    return this.pool.unbanNode(nodePubKey, args.reconnect);
  }

  public executeSwap = async (args: { orderId: string, pairId: string, peerPubKey: string, quantity: number }) => {
    if (!this.orderBook.nomatching) {
      throw errors.NOMATCHING_MODE_IS_REQUIRED();
    }

    const { orderId, pairId, peerPubKey } = args;
    const quantity = args.quantity > 0 ? args.quantity : undefined; // passing 0 quantity will work fine, but it's prone to bugs

    const maker = this.orderBook.removePeerOrder(orderId, pairId, peerPubKey, quantity).order;
    const taker = this.orderBook.stampOwnOrder({
      pairId,
      localId: '',
      price: maker.price,
      isBuy: !maker.isBuy,
      quantity: quantity || maker.quantity,
    });

    const swapSuccess = await this.orderBook.executeSwap(maker, taker);
    swapSuccess.localId = ''; // we shouldn't return the localId for ExecuteSwap in nomatching mode
    return swapSuccess;
  }

  /**
   * Gets information about a specified node.
   */
  public getNodeInfo = async (args: { nodeIdentifier: string }) => {
    argChecks.HAS_NODE_IDENTIFIER(args);
    const nodePubKey = isNodePubKey(args.nodeIdentifier) ? args.nodeIdentifier : this.pool.resolveAlias(args.nodeIdentifier);
    const info = await this.pool.getNodeReputation(nodePubKey);
    return info;
  }

  /**
   * Get general information about this Exchange Union node.
   */
  public getInfo = async (): Promise<XudInfo> => {
    const { nodePubKey, addresses, alias } = this.pool;

    const uris: string[] = [];

    if (addresses && addresses.length > 0) {
      addresses.forEach((address) => {
        uris.push(toUri({ nodePubKey, host: address.host, port: address.port }));
      });
    }

    let peerOrdersCount = 0;
    let ownOrdersCount = 0;
    const network = this.pool.getNetwork();

    let numPairs = 0;
    for (const pairId of this.orderBook.pairIds) {
      const peerOrders = this.orderBook.getPeersOrders(pairId);
      const ownOrders = this.orderBook.getOwnOrders(pairId);

      peerOrdersCount += Object.keys(peerOrders.buyArray).length + Object.keys(peerOrders.sellArray).length;
      ownOrdersCount += Object.keys(ownOrders.buyArray).length + Object.keys(ownOrders.sellArray).length;
      numPairs += 1;
    }

    const lnd = await this.swapClientManager.getLndClientsInfo();
    const raiden = await this.swapClientManager.raidenClient?.getRaidenInfo();
    if (raiden) {
      raiden.chain = `${raiden.chain ? raiden.chain : ''} ${this.pool.getNetwork()}`;
    }
    const connext = await this.swapClientManager.connextClient?.getInfo();
    if (connext) {
      connext.chain = `${connext.chain ? connext.chain : ''}connext ${this.pool.getNetwork()}`;
    }

    return {
      lnd,
      raiden,
      connext,
      nodePubKey,
      uris,
      numPairs,
      network,
      alias,
      version: `${this.version}${commitHash}`,
      numPeers: this.pool.peerCount,
      orders: {
        peer: peerOrdersCount,
        own: ownOrdersCount,
      },
      pendingSwapHashes: this.swaps.getPendingSwapHashes(),
    };
  }

  private toServiceOrder = (order: Order, includeAliases = false): ServiceOrder => {
    const { id, createdAt, pairId, price, quantity } = order;
    let serviceOrder: ServiceOrder;
    if (isOwnOrder(order)) {
      serviceOrder = {
        id,
        createdAt,
        pairId,
        price,
        quantity,
        side: order.isBuy ? OrderSide.Buy : OrderSide.Sell,
        isOwnOrder: true,
        localId: order.localId,
        hold: order.hold,
        nodeIdentifier: {
          nodePubKey: this.pool.nodePubKey,
          alias: includeAliases ? this.pool.alias : undefined,
        },
      };
    } else {
      serviceOrder = {
        id,
        createdAt,
        pairId,
        price,
        quantity,
        side: order.isBuy ? OrderSide.Buy : OrderSide.Sell,
        isOwnOrder: false,
        nodeIdentifier: {
          nodePubKey: order.peerPubKey,
          alias: includeAliases ? this.pool.getPeer(order.peerPubKey)?.alias : undefined,
        },
      };
    }
    return serviceOrder;
  }

  /**
   * Get a map between pair ids and its orders from the order book.
   */
  public listOrders = (
    args: { pairId: string, owner: Owner | number, limit: number, includeAliases: boolean },
    ): Map<string, ServiceOrderSidesArrays> => {
    const { pairId, owner, limit, includeAliases } = args;
    const includeOwnOrders = owner === Owner.Both || owner === Owner.Own;
    const includePeerOrders = owner === Owner.Both || owner === Owner.Peer;

    const result = new Map<string, ServiceOrderSidesArrays>();

    const listOrderTypes = (pairId: string) => {
      let buyArray: Order[] = [];
      let sellArray: Order[] = [];

      if (includePeerOrders) {
        const peerOrders = this.orderBook.getPeersOrders(pairId);

        buyArray = buyArray.concat(peerOrders.buyArray);
        sellArray = sellArray.concat(peerOrders.sellArray);
      }

      if (includeOwnOrders) {
        const ownOrders = this.orderBook.getOwnOrders(pairId);

        buyArray = buyArray.concat(ownOrders.buyArray);
        sellArray = sellArray.concat(ownOrders.sellArray);
      }

      // sort all orders
      buyArray = sortOrders(buyArray, true);
      sellArray = sortOrders(sellArray, false);

      if (limit > 0) {
        buyArray = buyArray.slice(0, limit);
        sellArray = sellArray.slice(0, limit);
      }

      return {
        buyArray: buyArray.map(order => this.toServiceOrder(order, includeAliases)),
        sellArray: sellArray.map(order => this.toServiceOrder(order, includeAliases)),
      };
    };

    if (pairId) {
      result.set(pairId, listOrderTypes(pairId));
    } else {
      this.orderBook.pairIds.forEach((pairId) => {
        result.set(pairId, listOrderTypes(pairId));
      });
    }

    return result;
  }

  /**
   * Get the list of the order book's supported currencies
   * @returns A list of supported currency ticker symbols
   */
  public listCurrencies = (): Map<string, Currency> => {
    return this.orderBook.currencies;
  }

  /**
   * Get the list of the order book's supported pairs.
   * @returns A list of supported trading pair tickers
   */
  public listPairs = () => {
    return this.orderBook.pairIds;
  }

  /**
   * Get information about currently connected peers.
   * @returns A list of connected peers with key information for each peer
   */
  public listPeers = () => {
    return this.pool.listPeers();
  }

  /**
   * Gets trading history.
   */
  public tradeHistory = async (args: { limit: number }): Promise<ServiceTrade[]> => {
    const { limit } = args;
    const trades = await this.orderBook.getTrades(limit);

    const orderInstanceToServiceOrder = (order: OrderAttributes, quantity: number): ServiceOrder => {
      const isOwnOrder = !!order.localId;
      let nodeIdentifier: NodeIdentifier;

      if (isOwnOrder) {
        nodeIdentifier = {
          nodePubKey: this.pool.nodePubKey,
          alias: this.pool.alias,
        };
      } else {
        const nodePubKey = this.pool.getNodePubKeyById(order.nodeId!)!;
        nodeIdentifier = {
          nodePubKey,
          alias: this.pool.getNodeAlias(nodePubKey),
        };
      }

      return {
        isOwnOrder,
        nodeIdentifier,
        quantity,
        id: order.id,
        pairId: order.pairId,
        price: order.price,
        side: order.isBuy ? OrderSide.Buy : OrderSide.Sell,
        localId: order.localId,
        createdAt: order.createdAt,
      };
    };

    const serviceTrades: ServiceTrade[] = trades.map((trade: TradeInstance) => {
      const takerOrder = trade.takerOrder ? orderInstanceToServiceOrder(trade.takerOrder, trade.quantity) : undefined;
      const makerOrder = orderInstanceToServiceOrder(trade.makerOrder!, trade.quantity);
      let role: SwapRole;
      let side: OrderSide;
      let counterparty: NodeIdentifier | undefined;

      if (takerOrder) {
        if (makerOrder.isOwnOrder) {
          role = SwapRole.Internal;
          side = OrderSide.Both;
        } else {
          role = SwapRole.Taker;
          side = takerOrder.side;
        }
      } else {
        // no taker order means we were the maker in a swap
        role = SwapRole.Maker;
        side = makerOrder.side;
      }

      if (trade.SwapDeal) {
        const nodePubKey = trade.SwapDeal.peerPubKey;
        counterparty = {
          nodePubKey,
          alias: this.pool.getNodeAlias(nodePubKey),
        };
      }

      return {
        makerOrder,
        takerOrder,
        role,
        side,
        counterparty,
        rHash: trade.rHash,
        quantity: trade.quantity,
        pairId: makerOrder.pairId,
        price: makerOrder.price!,
        executedAt: trade.createdAt.getTime(),
      };
    });

    return serviceTrades;
  }

  /**
   * Add an order to the order book.
   * If price is zero or unspecified a market order will get added.
   */
  public placeOrder = async (
    args: { pairId: string, price: number, quantity: number, orderId: string, side: number,
      replaceOrderId?: string, immediateOrCancel: boolean },
    callback?: (e: ServicePlaceOrderEvent) => void,
  ) => {
    const { pairId, price, quantity, orderId, side, replaceOrderId, immediateOrCancel } = args;
    argChecks.PRICE_NON_NEGATIVE(args);
    argChecks.POSITIVE_QUANTITY(args);
    argChecks.PRICE_MAX_DECIMAL_PLACES(args);
    argChecks.HAS_PAIR_ID(args);

    if (replaceOrderId) {
      this.orderBook.removeOwnOrderByLocalId(orderId, false);
    }

    const order: OwnMarketOrder | OwnLimitOrder = {
      pairId,
      price,
      quantity,
      isBuy: side === OrderSide.Buy,
      localId: orderId,
    };

    /** Modified callback that converts Order to ServiceOrder before passing to callback. */
    const serviceCallback: ((e: PlaceOrderEvent) => void) | undefined = callback ? (e) => {
      const { type, order, swapSuccess, swapFailure } = e;
      callback({
        type,
        swapSuccess,
        swapFailure,
        order: order ? this.toServiceOrder(order, true) : undefined,
      });
    } : undefined;

    return price > 0 ? await this.orderBook.placeLimitOrder(order, immediateOrCancel, serviceCallback) :
      await this.orderBook.placeMarketOrder(order, serviceCallback);
  }

  /** Removes a currency. */
  public removeCurrency = async (args: { currency: string }) => {
    argChecks.VALID_CURRENCY(args);
    const { currency } = args;

    await this.orderBook.removeCurrency(currency);
  }

  /** Removes a trading pair. */
  public removePair = async (args: { pairId: string }) => {
    argChecks.HAS_PAIR_ID(args);
    const { pairId } = args;

    return this.orderBook.removePair(pairId);
  }

  /** Discover nodes from a specific peer and apply new connections */
  public discoverNodes = async (args: { nodeIdentifier: string }) => {
    argChecks.HAS_NODE_IDENTIFIER(args);
    const nodePubKey = isNodePubKey(args.nodeIdentifier) ? args.nodeIdentifier : this.pool.resolveAlias(args.nodeIdentifier);
    return this.pool.discoverNodes(nodePubKey);
  }

  /*
   * Subscribe to orders being added to the order book.
   */
  public subscribeOrders = (args: { existing: boolean }, callback: (order?: Order, orderRemoval?: OrderPortion) => void) => {
    if (args.existing) {
      this.orderBook.pairIds.forEach((pair) => {
        const ownOrders = this.orderBook.getOwnOrders(pair);
        const peerOrders = this.orderBook.getPeersOrders(pair);
        ownOrders.buyArray.forEach(order => callback(order));
        peerOrders.buyArray.forEach(order => callback(order));
        ownOrders.sellArray.forEach(order => callback(order));
        peerOrders.sellArray.forEach(order => callback(order));
      });
    }

    this.orderBook.on('peerOrder.incoming', order => callback(order));
    this.orderBook.on('ownOrder.added', order => callback(order));

    this.orderBook.on('peerOrder.invalidation', orderRemoval => callback(undefined, orderRemoval));
    this.orderBook.on('peerOrder.filled', orderRemoval => callback(undefined, orderRemoval));
    this.orderBook.on('ownOrder.filled', orderRemoval => callback(undefined, orderRemoval));
    this.orderBook.on('ownOrder.removed', orderRemoval => callback(undefined, orderRemoval));
  }

  /*
   * Subscribe to completed swaps.
   */
  public subscribeSwaps = async (args: { includeTaker: boolean }, callback: (swapSuccess: SwapSuccess) => void) => {
    this.swaps.on('swap.paid', (swapSuccess) => {
      // always alert client for maker matches, taker matches only when specified
      if (swapSuccess.role === SwapRole.Maker || args.includeTaker) {
        callback(swapSuccess);
      }
    });
  }

  /*
   * Subscribe to failed swaps.
   */
  public subscribeSwapFailures = async (args: { includeTaker: boolean }, callback: (swapFailure: SwapFailure) => void) => {
    this.swaps.on('swap.failed', (deal) => {
      this.logger.trace(`notifying SwapFailure subscription for ${deal.rHash} with role ${SwapRole[deal.role]}`);
      // always alert client for maker matches, taker matches only when specified
      if (deal.role === SwapRole.Maker || args.includeTaker) {
        callback(deal as SwapFailure);
      }
    });
  }

  /**
   * Resolves a hash to its preimage.
   */
  public resolveHash = async (request: ResolveRequest) => {
    argChecks.HAS_RHASH(request);
    argChecks.POSITIVE_AMOUNT(request);
    return this.swaps.handleResolveRequest(request);
  }

  /**
   * Provides preimage for a hash.
   */
  public providePreimage = async (event: ProvidePreimageEvent) => {
    this.swapClientManager.connextClient?.emit('preimage', event);
  }

  /**
   * Notifies Connext client that a transfer has been received.
   */
  public transferReceived = async (event: TransferReceivedEvent) => {
    this.swapClientManager.connextClient?.emit('transferReceived', event);
  }

}
export default Service;
