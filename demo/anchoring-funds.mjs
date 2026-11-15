/**
 * The readiness check's verdict on the anchoring wallet's funds (CB-49): a wallet with nothing on
 * it (a new one, such as the shipping demo's) is "not funded", and anchoring waits until it is; a
 * low one says how much is needed.
 */

/**
 * The funds line of the readiness check.
 * @param {{ada: number, minimum: number, address: string, network: string}} wallet the wallet's
 *     funds, the minimum the install asks for, its address and network
 * @return {{status: string, item: string, detail: string, fix: string}}
 */
export function fundsVerdict({ada, minimum, address, network}) {
  const funds = `${ada.toLocaleString('en', {maximumFractionDigits: 2})} ADA`;
  const fix = `Send test ADA (${network}) to ${address}`;
  if (ada === 0) {
    return {
      status: 'fail',
      item: 'funds',
      detail: `wallet not funded: anchoring waits until it is (${funds}, at least ${minimum} needed)`,
      fix,
    };
  }
  if (ada < minimum) {
    return {
      status: 'fail',
      item: 'funds',
      detail: `${funds}, at least ${minimum} needed`,
      fix,
    };
  }
  return {
    status: 'ok',
    item: 'funds',
    detail: `${funds} (at least ${minimum} needed; each batch costs about 0.2 ADA)`,
    fix: '',
  };
}

/**
 * What a readiness check means for an install step (CB-49): ready; or waiting for funds, when the
 * only failing line is the wallet's funds (a new wallet: anchoring waits until it is funded, the
 * rest works); otherwise not ready.
 * @param {{ready: boolean, failItems: !Array<string>}} check the readiness check's answer
 * @return {{ok: boolean, waitsForFunds: boolean}}
 */
export function readinessOutcome({ready, failItems}) {
  if (ready) {
    return {ok: true, waitsForFunds: false};
  }
  const waitsForFunds =
    failItems.length > 0 && failItems.every(item => item === 'funds');
  return {ok: waitsForFunds, waitsForFunds};
}
