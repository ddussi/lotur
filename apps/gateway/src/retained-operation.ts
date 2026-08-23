export function retainAdmissionUntilSettled<T>(
  operation: Promise<T>,
  release: () => void,
): Promise<T> {
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  void operation.then(releaseOnce, releaseOnce);
  return operation;
}
