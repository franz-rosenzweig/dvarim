#!/bin/zsh
# Why won't it sign? Says what is wrong with keystore.properties without ever
# printing what is in it. See CheckKeystore.java.
set -euo pipefail
cd "${0:A:h}/.."
jdk=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.bubblewrap/config.json'))).get('jdkPath',''))" 2>/dev/null || true)
[[ -d $jdk/Contents/Home ]] && jdk=$jdk/Contents/Home
JAVA=${jdk:+$jdk/bin/java}; [[ -x ${JAVA:-} ]] || JAVA=java
exec $JAVA shell/CheckKeystore.java
