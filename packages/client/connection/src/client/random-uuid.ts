/** Browser-safe UUID generation for client-side wire correlation. */

// One implementation lives in the apiproxy browser channel (AbstractApiClient
// mints rpcIds there); re-exported so this package's call sites keep their
// local import path.
export { randomUuid } from '@deepseek-ai/dsh-host-apiproxy/client'
