#!/bin/bash
# Uso: longlog.sh <tag> <puerto> <minutos> <log>
TAG=$1; PORT=$2; MIN=$3; LOG=$4; T0=$(date +%s)
sleep 20
while [ $(( $(date +%s) - T0 )) -lt $(( MIN * 60 )) ]; do
  C=$(powershell -NoProfile -File E:/_cache/lagr-test/cpu.ps1 -Tag $TAG -Secs 10 | grep -oE 'gpu-process=[^ ]+|renderer=[^ ]+|rendererMB=[^ ]+' | tr '\n' ' ') &
  P=$(node E:/_cache/lagr-test/prof.mjs $PORT 10 E:/_cache/lagr-test/ll_$TAG noprof)
  wait
  C=$(powershell -NoProfile -File E:/_cache/lagr-test/cpu.ps1 -Tag $TAG -Secs 5 | tr '\n' ' ')
  A=$(CDP_PORT=$PORT node E:/_cache/lagr-test/cdp.mjs "document.getAnimations().length+' anims '+document.querySelectorAll('.xterm canvas').length+' canv'")
  echo "$(( ($(date +%s) - T0) / 60 ))min $C $P $A" >> $LOG
  sleep 100
done
