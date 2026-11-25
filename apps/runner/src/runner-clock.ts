export const currentIso = () => new Date().toISOString();

export const currentEpochMillis = () => Date.now();

export const delayMillis = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis);
  });
