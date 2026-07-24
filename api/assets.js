const NETWORKS = {
  '0x1': 'eth-mainnet',
  '0x38': 'bnb-mainnet',
  '0x89': 'polygon-mainnet',
  '0xa': 'opt-mainnet',
  '0xa4b1': 'arb-mainnet',
  '0x2105': 'base-mainnet',
  '0xaa36a7': 'eth-sepolia'
};

const isAddress = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const formatUnits = (raw, decimals) => {
  const value = BigInt(raw || '0x0');
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

export default async function handler(req, res) {
  const { address, chainId } = req.query;
  if (!isAddress(address) || !NETWORKS[chainId]) return res.status(400).json({ error: 'A supported chain and EVM address are required.' });
  if (!process.env.ALCHEMY_API_KEY) return res.status(503).json({ error: 'Asset discovery is not configured. Set ALCHEMY_API_KEY in Vercel.' });
  const rpc = `https://${NETWORKS[chainId]}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  const call = async (method, params) => {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error?.message || 'Portfolio provider request failed');
    return data.result;
  };
  try {
    const result = await call('alchemy_getTokenBalances', [address]);
    const balances = (result.tokenBalances || []).filter(token => token.tokenBalance && BigInt(token.tokenBalance) > 0n);
    const assets = await Promise.all(balances.slice(0, 100).map(async ({ contractAddress, tokenBalance }) => {
      const metadata = await call('alchemy_getTokenMetadata', [contractAddress]).catch(() => ({}));
      const decimals = Number.isInteger(metadata.decimals) ? metadata.decimals : 18;
      return { contract: contractAddress, symbol: metadata.symbol || 'Token', decimals, balance: tokenBalance, formattedBalance: formatUnits(tokenBalance, decimals), logo: metadata.logo || null };
    }));
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.status(200).json({ assets });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Asset discovery failed.' });
  }
}
