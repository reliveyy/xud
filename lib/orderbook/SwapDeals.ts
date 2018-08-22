import { SwapDealRole } from '../types/enums';

type SwapDeal = {
  /** The role of the local node in the swap. */
  myRole: SwapDealRole; // TODO: consider changing myRole to boolean named isTaker or isMaker
  /** Global order id in the XU network. */
  orderId?: string;
  takerDealId: string;
  takerAmount: number;
  /** The currency the taker is expecting to receive. */
  takerCurrency: string;
  takerPubKey: string;
  makerDealId?: string;
  makerAmount: number;
  /** The currency the maker is expecting to receive. */
  makerCurrency: string;
  makerPubKey?: string;
  /** The hash of the preimage. */
  r_hash?: string;
  r_preimage?: string;
  createTime: number;
  executeTime?: number;
  competionTime?: number
};

export class SwapDeals {
  private deals: SwapDeal[] = [];

  public get = (role: SwapDealRole, dealId: string): SwapDeal | undefined => {
    for (const deal of this.deals) {
      if (role === SwapDealRole.Maker && deal.makerDealId === dealId) {
        return deal;
      }
      if (role === SwapDealRole.Taker && deal.takerDealId === dealId) {
        return deal;
      }
    }
    return undefined;
  }

  public findByHash = (hash: string): SwapDeal | undefined => {
    for (const deal of this.deals) {
      if (hash === deal.r_hash) {
        return deal;
      }
    }
    return undefined;
  }

  public add = (deal: SwapDeal) => {
    this.deals.push(deal);
  }
}

export default SwapDeals;
export { SwapDeal };