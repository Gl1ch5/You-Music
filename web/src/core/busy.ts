import { app } from './store';

/** Shows the global loading bar while [work] runs, so every tap gets visible feedback even before results arrive. */
export async function busy<T>(work: Promise<T> | (() => Promise<T>)): Promise<T> {
  app.busy.value = app.busy.peek() + 1;
  try {
    return await (typeof work === 'function' ? work() : work);
  } finally {
    app.busy.value = Math.max(0, app.busy.peek() - 1);
  }
}
