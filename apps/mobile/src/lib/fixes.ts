import { store } from "./store";

/** Remember the country the user picked for a payee (used for every payment to it). */
export async function setCountry(payee: string, iso: string): Promise<void> {
  await store.update((d) => ({ prefs: { ...d.prefs, overrides: { ...d.prefs.overrides, [payee]: iso } } }));
}

export async function clearCountry(payee: string): Promise<void> {
  await store.update((d) => {
    const { [payee]: _gone, ...rest } = d.prefs.overrides;
    return { prefs: { ...d.prefs, overrides: rest } };
  });
}
