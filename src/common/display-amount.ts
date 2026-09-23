/**
 * An amount as it reads inside an error message: grouped thousands, cents only
 * when there are any ("30 000", "12.50"). Locale-neutral on purpose — the
 * message is localized on the client, the number is not.
 */
export function displayAmount(value: number): string {
  const [whole, cents] = value.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return cents === '00' ? grouped : `${grouped}.${cents}`;
}
