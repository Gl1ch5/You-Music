/** System back button: the most recently registered handler that returns true consumes the press. */
const handlers: (() => boolean)[] = [];

export function onBack(handler: () => boolean): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.lastIndexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export function handleBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]()) return true;
  }
  return false;
}
