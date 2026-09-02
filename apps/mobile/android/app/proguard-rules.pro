# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── Hermes ───────────────────────────────────────────────────────────
# Capacitor reaches plugin methods and callbacks by reflection AND reads the
# @CapacitorPlugin annotation (permissions aliases) at runtime — R8 must keep
# the runtime-visible annotations, or getPermissionState() NPEs in release.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault,Signature
-keep @interface com.getcapacitor.annotation.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class com.nousresearch.hermes.** { *; }
-keep class com.nousresearch.hermes.HermesConnectionService { *; }
-keep class com.nousresearch.hermes.NotificationActionReceiver { *; }
# OkHttp / Okio ship consumer rules; silence the optional-dependency warnings.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
# Tink (via androidx.security:security-crypto) references compile-only
# errorprone annotations that are not on the runtime classpath.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
