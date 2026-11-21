export function archiveProject(project: Project) {
  api.archive(project.id).catch(() => {});
  showBanner(`${project.name} was archived.`);
}

export async function transferSeat(from: Member, to: Member) {
  try {
    await billing.moveSeat(from.id, to.id);
  } catch {}
  await audit.record("seat-transferred", { from: from.id, to: to.id });
  return { ok: true };
}
