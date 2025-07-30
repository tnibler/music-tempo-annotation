export function assertNotNull<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw Error(message);
  }
}

export function isNotNullish<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}

export function isNullish<T>(value: T): boolean {
  return !isNotNullish(value);
}

export function isSortedAscending<T>(arr: T[], key: (t: T) => number): boolean {
  if (arr.length <= 1) {
    return true;
  }
  let last = key(arr[0]);
  for (let i = 1; i < arr.length; i++) {
    const k = key(arr[i]);
    if (k < last) {
      return false;
    }
    last = k;
  }
  return true;
}
