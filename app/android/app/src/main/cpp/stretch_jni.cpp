// Speed and key changes for the playback engine (audio/Stretch.java), with
// Signalsmith Stretch (MIT): the formants are kept where they are when the
// key moves, so a voice raised by a few semitones still sounds like the
// singer, not like a chipmunk.
#include <jni.h>
#include <vector>

#include "signalsmith-stretch/signalsmith-stretch.h"

namespace {
struct State {
    signalsmith::stretch::SignalsmithStretch<float> st;
    std::vector<float> inL, inR, outL, outR;
};
}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL Java_app_stemkitmobile_audio_Stretch_create(JNIEnv *, jclass, jint sampleRate) {
    auto *s = new State();
    s->st.presetDefault(2, (float)sampleRate);
    s->st.setFormantFactor(1, true);
    s->st.setFormantBase(0);
    return reinterpret_cast<jlong>(s);
}

JNIEXPORT void JNICALL Java_app_stemkitmobile_audio_Stretch_destroy(JNIEnv *, jclass, jlong h) {
    delete reinterpret_cast<State *>(h);
}

JNIEXPORT void JNICALL Java_app_stemkitmobile_audio_Stretch_setKey(JNIEnv *, jclass, jlong h, jfloat semitones, jboolean keepFormants) {
    auto *s = reinterpret_cast<State *>(h);
    s->st.setTransposeSemitones(semitones);
    // compensatePitch: the spectral envelope stays put while the notes move
    s->st.setFormantFactor(1, keepFormants == JNI_TRUE);
}

JNIEXPORT void JNICALL Java_app_stemkitmobile_audio_Stretch_reset(JNIEnv *, jclass, jlong h) {
    reinterpret_cast<State *>(h)->st.reset();
}

JNIEXPORT jint JNICALL Java_app_stemkitmobile_audio_Stretch_latency(JNIEnv *, jclass, jlong h) {
    auto *s = reinterpret_cast<State *>(h);
    return s->st.inputLatency() + s->st.outputLatency();
}

/** interleaved stereo in (inFrames) -> interleaved stereo out (outFrames): the ratio is the speed */
JNIEXPORT void JNICALL Java_app_stemkitmobile_audio_Stretch_process(JNIEnv *env, jclass, jlong h, jfloatArray in, jint inFrames, jfloatArray out,
                                                                      jint outFrames) {
    auto *s = reinterpret_cast<State *>(h);
    if ((int)s->inL.size() < inFrames) {
        s->inL.resize(inFrames);
        s->inR.resize(inFrames);
    }
    if ((int)s->outL.size() < outFrames) {
        s->outL.resize(outFrames);
        s->outR.resize(outFrames);
    }
    jfloat *src = env->GetFloatArrayElements(in, nullptr);
    for (int i = 0; i < inFrames; i++) {
        s->inL[i] = src[2 * i];
        s->inR[i] = src[2 * i + 1];
    }
    env->ReleaseFloatArrayElements(in, src, JNI_ABORT);
    float *ins[2] = {s->inL.data(), s->inR.data()};
    float *outs[2] = {s->outL.data(), s->outR.data()};
    s->st.process(ins, inFrames, outs, outFrames);
    jfloat *dst = env->GetFloatArrayElements(out, nullptr);
    for (int i = 0; i < outFrames; i++) {
        dst[2 * i] = s->outL[i];
        dst[2 * i + 1] = s->outR[i];
    }
    env->ReleaseFloatArrayElements(out, dst, 0);
}
}
