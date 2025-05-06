#!/bin/sh

# Copy docker config
echo "::debug::Copying docker config to /kaniko/.docker/config.json"
cp _tmp/kaniko/.docker/config.json /kaniko/.docker/config.json

# Normalize tags input: replace commas with newlines, remove spaces and empty lines
NORMALIZED_TAGS=$(echo "${TAGS}" | sed -e 's/,/\n/g' -e 's/ //g' -e '/^[[:space:]]*$/d')

# Read each tag and append --destination
DESTINATIONS=""
for tag in $NORMALIZED_TAGS; do
  DESTINATIONS="$DESTINATIONS --destination $tag"
done

# Set IFS to null to allow spaces in build args
echo "::debug::Set IFS to null"
export IFS=''

# Construct the kaniko command string
KANIKO_CMD="/kaniko/executor --context=\"$CONTEXT\" --dockerfile=\"$DOCKERFILE\" --cleanup --log-timestamp $DESTINATIONS $EXTRA_KANIKO_ARGS"

# Replace newlines with spaces
KANIKO_CMD=$(echo "$KANIKO_CMD" | tr '\n' ' ')

echo "::debug::Kaniko command: '$KANIKO_CMD'"

# Run kaniko
echo "::debug::Executing kaniko..."
sh -c "$KANIKO_CMD"
