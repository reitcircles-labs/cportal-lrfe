import qrcode from 'qrcode-generator';

/**
 * The modules of a QR code for `text`, row by row (true: dark), the smallest version that holds
 * it, with error correction level M (15 % of the code can be lost, as on a creased printout).
 * @return {!Array<!Array<boolean>>}
 */
export function qrModules(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < size; row++) {
    const modules = [];
    for (let column = 0; column < size; column++) {
      modules.push(qr.isDark(row, column));
    }
    rows.push(modules);
  }
  return rows;
}
