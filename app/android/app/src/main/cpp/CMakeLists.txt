cmake_minimum_required(VERSION 3.22)
project(stemkit_audio CXX)

add_library(stemkit_stretch SHARED stretch_jni.cpp)
target_include_directories(stemkit_stretch PRIVATE third_party)
target_compile_features(stemkit_stretch PRIVATE cxx_std_17)
target_compile_options(stemkit_stretch PRIVATE -O3 -ffast-math -fno-exceptions)
