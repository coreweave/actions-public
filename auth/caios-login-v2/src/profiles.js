// Replace the selected profile as a whole; preserve unrelated sections verbatim.
export function withoutProfile(contents, profile, config = false) {
  let omit = false;
  return contents
    .split(/(?<=\n)/)
    .filter((line) => {
      const section = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line.trimEnd());
      if (section) {
        let name = section[1].trim();
        if (config && name !== "default") {
          name = /^profile\s+(.+)$/.exec(name)?.[1] || null;
          name = name?.replace(/^(["'])(.*)\1$/, "$2");
        }
        omit = name === profile;
      }
      return !omit;
    })
    .join("");
}

export function configureProfile(contents, profile, { region, s3Endpoint, command }) {
  const name = /^[\w/.%@:+-]+$/.test(profile) ? profile : `"${profile}"`;
  const section = profile === "default" ? "default" : `profile ${name}`;
  return `${withoutProfile(contents, profile, true)}\n[${section}]
region = ${region}
endpoint_url = ${s3Endpoint}
s3 =
    addressing_style = virtual
credential_process = ${command}
`;
}
