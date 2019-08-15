import * as db from '../../db/types';
import { SwapClientType } from '../../constants/enums';

const nodes = [
  {
    nodePubKey: '02b66438730d1fcdf4a4ae5d3d73e847a272f160fee2938e132b52cab0a0d9cfc6',
    addresses: [{ host: 'xud1.simnet.exchangeunion.com', port: 8885 }],
  },
  {
    nodePubKey: '028599d05b18c0c3f8028915a17d603416f7276c822b6b2d20e71a3502bd0f9e0a',
    addresses: [{ host: 'xud2.simnet.exchangeunion.com', port: 8885 }],
  },
  {
    nodePubKey: '03fd337659e99e628d0487e4f87acf93e353db06f754dccc402f2de1b857a319d0',
    addresses: [{ host: 'xud3.simnet.exchangeunion.com', port: 8885 }],
  },
] as db.NodeAttributes[];

const currencies = [
  { id: 'BTC', swapClient: SwapClientType.Lnd, decimalPlaces: 8 },
  { id: 'LTC', swapClient: SwapClientType.Lnd, decimalPlaces: 8 },
  {
    id: 'WETH',
    swapClient: SwapClientType.Raiden,
    decimalPlaces: 18,
    tokenAddress: '0x9F50cEA29307d7D91c5176Af42f3aB74f0190dD3',
  },
  {
    id: 'DAI',
    swapClient: SwapClientType.Raiden,
    decimalPlaces: 18,
    tokenAddress: '0x76671A2831Dc0aF53B09537dea57F1E22899655d',
  },
] as db.CurrencyAttributes[];

const pairs = [
  { baseCurrency: 'LTC', quoteCurrency: 'BTC' },
  { baseCurrency: 'WETH', quoteCurrency: 'BTC' },
  { baseCurrency: 'BTC', quoteCurrency: 'DAI' },
  { baseCurrency: 'LTC', quoteCurrency: 'DAI' },
] as db.PairAttributes[];

export {
  nodes,
  currencies,
  pairs,
};