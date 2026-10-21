export function validUsername(value: string) {
  return /^[a-zA-Z0-9_]{3,24}$/.test(value);
}
export function validPassword(value: string) {
  return value.length >= 8 &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value) &&
    /[^A-Za-z0-9]/.test(value);
}
export function cleanUsername(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}