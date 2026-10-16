// TAP reports the aggregate's message but omits its nested errors. Inspect the
// actual runner failure so the regression verifies that both causes survive.
export default async function* errorsReporter(events) {
  function* messages(error) {
    if (!error) return;
    yield `cleanup-error: ${error.message}\n`;
    yield* messages(error.cause);
    for (const nested of error.errors || []) yield* messages(nested);
  }
  for await (const event of events) {
    if (event.type === 'test:fail') yield* messages(event.data.details.error);
  }
}
