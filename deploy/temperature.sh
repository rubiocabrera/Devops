#!/bin/sh
# Envía la temperatura del host a OpenObserve (stream "host_temperature") cada 30 s.
# Lee las zonas térmicas del kernel (/sys/class/thermal) y los sensores hwmon.
# En instancias EC2 virtualizadas (Nitro) normalmente el hipervisor NO expone
# sensores térmicos al sistema invitado; en ese caso se envía available=false
# para dejar constancia explícita en el dashboard.
SYS=/host/sys/class
INTERVAL=${INTERVAL:-30}

while true; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  BODY=""
  for f in "$SYS"/thermal/thermal_zone*/temp "$SYS"/hwmon/hwmon*/temp*_input; do
    [ -r "$f" ] || continue
    RAW=$(cat "$f" 2>/dev/null) || continue
    [ -n "$RAW" ] || continue
    C=$(awk "BEGIN{printf \"%.1f\", $RAW/1000}")
    SENSOR=$(echo "$f" | sed "s#$SYS/##")
    BODY="$BODY{\"_timestamp\":\"$TS\",\"host\":\"$HOST_NAME\",\"sensor\":\"$SENSOR\",\"celsius\":$C,\"available\":true},"
  done
  if [ -z "$BODY" ]; then
    BODY="{\"_timestamp\":\"$TS\",\"host\":\"$HOST_NAME\",\"sensor\":\"none\",\"available\":false,\"reason\":\"El hipervisor de EC2 no expone sensores termicos a la instancia\"},"
  fi
  curl -s -o /dev/null -w "temperature push: %{http_code}\n" \
    -H "Authorization: Basic $O2_AUTH" -H "Content-Type: application/json" \
    -X POST "$O2_URL/api/default/host_temperature/_json" \
    -d "[${BODY%,}]" || true
  sleep "$INTERVAL"
done
