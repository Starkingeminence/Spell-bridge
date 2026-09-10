const NETWORKS = Object.freeze({
  '0x1': 'eth-mainnet',
  '0x38': 'bnb-mainnet',
  '0x89': 'polygon-mainnet',
  '0xa': 'opt-mainnet',
  '0xa4b1': 'arb-mainnet',
  '0x2105': 'base-mainnet',
  '0xaa36a7': 'eth-sepolia'
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BALANCE = /^0x[0-9a-fA-F]{1,64}$/;

function cleanSymbol(value) {
  if (typeof value !== 'string') return 'Unknown token';

  return value
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      ''
    )
    .trim()
    .slice(0, 40) || 'Unknown token';
}

function formatBalance(raw, decimals) {
  const amount = BigInt(raw);

  if (decimals === 0) return amount.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;

  const fraction = (amount % scale)
    .toString()
    .padStart(decimals, '0')
    .slice(0, 6)
    .replace(/0+$/, '');

  if (amount > 0n && whole === 0n && !fraction) {
    return '<0.000001';
  }

  return fraction
    ? `${whole}.${fraction}`
    : whole.toString();
}

async function mapWithConcurrency(items, limit, transform) {
  const output = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await transform(items[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    )
  );

  return output;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');

    return res.status(405).json({
      error: 'Method not allowed.'
    });
  }

  const { address, chainId } = req.query;

  if (
    typeof address !== 'string' ||
    !ADDRESS.test(address) ||
    typeof chainId !== 'string' ||
    !Object.prototype.hasOwnProperty.call(NETWORKS, chainId)
  ) {
    return res.status(400).json({
      error: 'A supported chain and valid EVM address are required.'
    });
  }

  const apiKey = process.env.ALCHEMY_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error:
        'Token discovery is not configured. ' +
        'The site operator must set ALCHEMY_API_KEY.'
    });
  }

  const endpoint =
    `https://${NETWORKS[chainId]}.g.alchemy.com/v2/` +
    encodeURIComponent(apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let rpcId = 0;

  async function call(method, params) {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method,
        params
      })
    });

    if (!response.ok) {
      throw new Error('Portfolio provider HTTP failure.');
    }

    const data = await response.json();

    if (
      data.error ||
      data.result === undefined ||
      data.result === null
    ) {
      throw new Error('Portfolio provider RPC failure.');
    }

    return data.result;
  }

  try {
    const result = await call('alchemy_getTokenBalances', [
      address,
      'erc20'
    ]);

    if (!Array.isArray(result.tokenBalances)) {
      throw new Error('Invalid token balance response.');
    }

    const seen = new Set();

    const balances = result.tokenBalances.filter(item => {
      if (
        !item ||
        item.error ||
        typeof item.contractAddress !== 'string' ||
        !ADDRESS.test(item.contractAddress) ||
        typeof item.tokenBalance !== 'string' ||
        !BALANCE.test(item.tokenBalance) ||
        BigInt(item.tokenBalance) <= 0n
      ) {
        return false;
      }

      const key = item.contractAddress.toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    });

    /*
     * Bounded discovery:
     * - At most 100 tokens per request.
     * - At most 5 metadata requests in flight.
     * - Pagination is reported as partial rather than silently ignored.
     */
    const selected = balances.slice(0, 100);
    let metadataIncomplete = false;

    const assets = await mapWithConcurrency(
      selected,
      5,
      async ({ contractAddress, tokenBalance }) => {
        let metadata = {};

        try {
          metadata = await call('alchemy_getTokenMetadata', [
            contractAddress
          ]) || {};
        } catch {
          if (controller.signal.aborted) {
            throw new Error('Token discovery timed out.');
          }

          metadataIncomplete = true;
        }

        const decimals =
          Number.isInteger(metadata.decimals) &&
          metadata.decimals >= 0 &&
          metadata.decimals <= 255
            ? metadata.decimals
            : null;

        if (decimals === null) metadataIncomplete = true;

        return {
          contract: contractAddress,
          symbol: cleanSymbol(metadata.symbol),
          decimals,
          balance: tokenBalance,
          formattedBalance:
            decimals === null
              ? 'Precision unknown'
              : formatBalance(tokenBalance, decimals)
        };
      }
    );

    return res.status(200).json({
      assets,
      partial:
        Boolean(result.pageKey) ||
        balances.length > selected.length ||
        metadataIncomplete ||
        result.tokenBalances.some(item => item?.error)
    });
  } catch {
    const timedOut = controller.signal.aborted;

    return res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? 'Token discovery timed out. Try again or import a contract manually.'
        : 'Token discovery is unavailable for this network or provider configuration.'
    });
  } finally {
    clearTimeout(timeout);
  }
}
