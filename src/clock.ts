export function now(): Date {
  const fake = process.env.FAKE_NOW;
  return fake ? new Date(fake) : new Date();
}