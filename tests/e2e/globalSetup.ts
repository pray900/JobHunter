import { stack } from './lib';

export async function setup(): Promise<void> {
  await stack.up();
}

export async function teardown(): Promise<void> {
  // Keep the stack up when iterating: E2E_KEEP_STACK=1
  if (process.env.E2E_KEEP_STACK !== '1') await stack.down();
}
