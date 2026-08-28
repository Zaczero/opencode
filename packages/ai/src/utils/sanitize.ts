import { isRecord } from "./record.js"

export const sanitizeSurrogates = <T>(value: T): T => {
  if (typeof value === "string") {
    const sanitized = value.toWellFormed()
    return (sanitized === value ? value : sanitized) as T
  }
  if (Array.isArray(value)) {
    const array = value as ReadonlyArray<unknown>
    let result: Array<unknown> | undefined
    for (let index = 0; index < array.length; index++) {
      if (!(index in array)) continue
      const entry = array[index]
      const sanitized = sanitizeSurrogates(entry)
      if (sanitized === entry) {
        if (result) result[index] = sanitized
        continue
      }
      if (!result) result = array.slice()
      result[index] = sanitized
    }
    return (result ?? value) as T
  }
  if (value instanceof Uint8Array || value instanceof Error) return value
  if (isRecord(value)) {
    const keys = Object.keys(value)
    let entries: Array<[string, unknown]> | undefined
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      const sanitizedKey = key.toWellFormed()
      const entry = value[key]
      const sanitized = sanitizeSurrogates(entry)
      if (sanitizedKey === key && sanitized === entry) {
        if (entries) entries.push([key, sanitized])
        continue
      }
      if (!entries)
        entries = keys.slice(0, index).map((key): [string, unknown] => [key, value[key]])
      entries.push([sanitizedKey, sanitized])
    }
    return (entries === undefined ? value : Object.fromEntries(entries)) as T
  }
  return value
}
