const fs = require('node:fs');
const path = require('node:path');
const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const file of ['index.html', 'styles.css', 'app.js', 'admin.html', 'escrow.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}

const config = {
  apiBaseUrl: process.env.WATHIQ_API_BASE_URL || '',
  escrowAddress: process.env.WATHIQ_ESCROW_ADDRESS || '',
  chainId: Number(process.env.WATHIQ_CHAIN_ID || 97),
  chainName: process.env.WATHIQ_CHAIN_NAME || 'BNB Smart Chain Testnet',
  rpcUrl: process.env.WATHIQ_RPC_URL || 'https://bsc-testnet-dataseed.bnbchain.org',
  explorerUrl: process.env.WATHIQ_EXPLORER_URL || 'https://testnet.bscscan.com',
};
fs.writeFileSync(path.join(out, 'config.js'), 'window.WATHIQ_CONFIG = ' + JSON.stringify(config, null, 2) + ';\n');
console.log('Static web bundle built. API endpoint configured:', Boolean(config.apiBaseUrl));
console.log('Escrow contract address configured:', Boolean(config.escrowAddress));
