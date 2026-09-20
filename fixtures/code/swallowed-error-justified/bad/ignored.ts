try {
  await saveDraft(document);
} catch {
  // ignore
}

try {
  chargeCard(order);
} catch (error) {
  // TODO
}

try {
  const settings = JSON.parse(raw);
  apply(settings);
} catch (e) {
  /* swallow */
}

try {
  await syncInventory();
} catch {}

try {
  migrateUserRecords();
} catch {
  // should never happen
}
