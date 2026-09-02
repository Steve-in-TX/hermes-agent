#!/usr/bin/env bash
# Compile + run the M0 spike against a live gateway.
#   ./run.sh http://<gateway-host>:<port> <user> <password>
# Uses the OkHttp/Okio/Kotlin-stdlib jars already in ~/.gradle (from the
# desktop/Android toolchain); no Gradle project needed for a spike.
set -euo pipefail
cd "$(dirname "$0")"
G=~/.gradle/caches/modules-2/files-2.1
CP="$(find $G/com.squareup.okhttp3/okhttp/4.12.0 -name 'okhttp-4.12.0.jar' | head -1)"
CP="$CP:$(find $G/com.squareup.okio/okio-jvm/3.9.0 -name 'okio-jvm-3.9.0.jar' | head -1)"
CP="$CP:$(find $G/org.jetbrains.kotlin/kotlin-stdlib/1.9.0 -name 'kotlin-stdlib-1.9.0.jar' | head -1)"
mkdir -p out
javac -cp "$CP" -d out M0Spike.java
exec java -cp "$CP:out" M0Spike "$@"
