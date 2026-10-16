import { collectPublishingScenes, type PublishingProject, type PublishingScope, type PublishingScene } from "./project.js";

export interface VerticalPrintSection {
  id: string;
  title: string;
  body: string;
}

/** Collect the same all/volume/chapter scene ranges as the source print panel. */
export function collectScenesForVerticalPrint(
  project: PublishingProject,
  scope: PublishingScope,
  id?: string,
): PublishingScene[] {
  return collectPublishingScenes(project, scope, id);
}

/** Keep source headings and spacing for the browser's Japanese vertical print preview. */
export function composeVerticalPrintText(sections: VerticalPrintSection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    const body = section.body.replace(/\s+$/u, "");
    if (!body) continue;
    parts.push(section.title + "\n\n" + body);
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
}
