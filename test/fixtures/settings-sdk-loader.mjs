// Isolate only the external SDK's path lookup. All settings behavior comes from
// the production module. No installed Pi runtime, accounts or user HOME needed.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@earendil-works/pi-coding-agent') {
      return { url: 'data:text/javascript,export function getAgentDir() { return process.env.PI_CODING_AGENT_DIR; }', shortCircuit: true };
    }
    return next(specifier, context);
  },
});
