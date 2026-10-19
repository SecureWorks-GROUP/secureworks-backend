// A caller-facing message about bad input or a business rule. It is built only
// from literals and the caller's own values, never from store or provider
// text, so the general ops-api catch returns it exactly as before. Any other
// plain Error reaching that catch is unexpected and is answered 'Internal error'.
export class ClientInputError extends Error {}
