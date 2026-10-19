// A message ops-api has always returned to its caller: a fixed text, or one
// built only from the caller's values and business rules, never from store or
// provider text. The general ops-api catch returns it exactly as before. Any
// other plain Error reaching that catch is unexpected and is answered
// 'Internal error'.
export class ClientInputError extends Error {}
