# NewPipeExtractor uses reflection-free code but relies on Rhino and jsoup internals.
-keep class org.schabi.newpipe.extractor.** { *; }
-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.classfile.ClassFileWriter
-dontwarn org.mozilla.javascript.tools.**
-dontwarn java.beans.**
-dontwarn javax.script.**
-dontwarn jdk.dynalink.**
-dontwarn com.google.re2j.**
-dontwarn org.jspecify.annotations.**

# Bridge DTOs are serialized by kotlinx.serialization.
-keepattributes *Annotation*, InnerClasses, Signature
-keep,includedescriptorclasses class app.youmusic.**$$serializer { *; }
-keepclassmembers class app.youmusic.** { *** Companion; }
-keepclasseswithmembers class app.youmusic.** { kotlinx.serialization.KSerializer serializer(...); }
