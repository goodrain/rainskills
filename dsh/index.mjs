import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const name = "rainskills-dsh";
export const inject = ["skills"];

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillDirectory = join(
  packageRoot,
  "marketplace",
  "rainskills",
  "skills",
  "rainskills",
);
const skillPath = join(skillDirectory, "SKILL.md");

export function parseSkillSource(source, sourcePath = "<skill>") {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`Invalid skill frontmatter: ${sourcePath}`);

  let frontmatter;
  try {
    frontmatter = parseYaml(match[1]);
  } catch (error) {
    throw new Error(`Invalid skill frontmatter: ${sourcePath}`, { cause: error });
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`Invalid skill frontmatter: ${sourcePath}`);
  }
  if (frontmatter.name !== "rainskills") {
    throw new Error(`Unexpected skill name "${frontmatter.name || ""}": ${sourcePath}`);
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new Error(`Missing description in skill frontmatter: ${sourcePath}`);
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description.trim(),
    content: match[2],
  };
}

function readSkillDefinition() {
  return parseSkillSource(readFileSync(skillPath, "utf8"), skillPath);
}

export function apply(ctx) {
  const definition = readSkillDefinition();
  const registration = {
    name: definition.name,
    description: definition.description,
    invocation: {
      modelInvocable: true,
      userInvocable: true,
    },
    source: "bundled",
    provider: name,
    resourceBase: {
      kind: "directory",
      path: skillDirectory,
    },
    path: skillPath,
    content: definition.content,
  };

  ctx.effect(
    () => ctx.skills.register(registration),
    "rainskills-dsh: register bootstrap skill",
  );
}
