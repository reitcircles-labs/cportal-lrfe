// `ng serve` proxy for the test stack: like angular-app/proxy.conf.json, but to the test gateway.
import { GATEWAY_URL } from './config.mjs';

export default {
    '/api': { target: GATEWAY_URL, secure: false, changeOrigin: false, logLevel: 'warn' }
};
