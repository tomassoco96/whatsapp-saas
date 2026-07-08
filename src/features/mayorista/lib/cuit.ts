// Validacion de CUIT con digito verificador (modulo 11). Portado del motor v1.
// Gate fiscal del mayorista: sin CUIT valido no hay lead calificado.

// Multiplicadores del digito verificador, aplicados a los primeros 10 digitos.
const MULTIPLIERS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Deja solo los digitos (acepta CUIT con guiones, puntos o espacios). */
export function normalizeCuit(value: string): string {
  return value.replace(/\D/g, "");
}

/** true si el CUIT tiene 11 digitos y digito verificador valido (modulo 11). */
export function isValidCuit(value: string): boolean {
  const digits = normalizeCuit(value);
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false; // 11 digitos iguales no es valido
  const nums = digits.split("").map(Number);
  const sum = MULTIPLIERS.reduce((acc, m, i) => acc + m * nums[i]!, 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false; // por convencion, esos CUIT no se emiten
  return check === nums[10];
}

/** Formatea 11 digitos como XX-XXXXXXXX-X. Si no son 11 digitos, devuelve tal cual. */
export function formatCuit(value: string): string {
  const d = normalizeCuit(value);
  if (d.length !== 11) return value;
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}
