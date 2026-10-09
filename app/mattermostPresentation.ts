/** Display configured project labels without changing server identities. */
export function mattermostPresentation(channel: {name:string;label:string;type:string;registry_slug?:string|null}, projects: Array<{slug:string;name:string}> = []) {
  const project=projects.find(p=>p.slug===channel.registry_slug);
  return {label:project?.name ?? channel.label, icon:channel.type==='D'?'@':project?'◇':'#', project:project?.slug ?? channel.registry_slug};
}
