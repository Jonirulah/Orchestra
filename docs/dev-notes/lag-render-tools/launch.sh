#!/bin/bash
# Uso: launch.sh <exe> <etiqueta> <puerto> <N>
EXE="$1"; TAG="$2"; PORT="$3"; N="${4:-6}"
for v in $(env | grep -oE '^(CLAUDE[A-Z_]*|ORCHESTRA_[A-Z_]*|NO_COLOR|TERM|ANTHROPIC[A-Z_]*)=' | tr -d '='); do unset "$v"; done
D="E:\\_cache\\lagr-test\\run-$TAG"
IGN=$(node -e "const fs=require('fs'),os=require('os'),p=require('path');console.log(JSON.stringify(fs.readdirSync(os.homedir()).filter(n=>/^\\.claude/.test(n)).map(n=>p.join(os.homedir(),n))))")
rm -rf "/e/_cache/lagr-test/run-$TAG/data"
node /e/_cache/lagr-test/seed.cjs "$N" "$D\\data" "$IGN" >/dev/null
export ORCHESTRA_DATA_DIR="$D\\data"
export WEBVIEW2_USER_DATA_FOLDER="$D\\wv2"
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$PORT"
"$EXE" > "/e/_cache/lagr-test/run-$TAG.log" 2>&1 &
echo $!
