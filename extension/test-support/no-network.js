// Imported by unit tests: any real fetch throws, so unit tests can never reach the VM.
globalThis.fetch = async (url) => {
  throw new Error(`unit tests must not hit the network (attempted ${url})`);
};
