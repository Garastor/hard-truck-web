/*
 * Обгортка декодера Indeo 5 (FFmpeg libavcodec, LGPL-2.1) для WebAssembly — ролики HT2 (*.bne, AVI IV50).
 * JS кладе стиснений кадр у буфер iv_input, викликає iv_decode і читає RGBA з iv_rgba (width × height × 4).
 * Перетворення YUV 4:1:0 → RGB — BT.601 обмеженого діапазону (як swscale у ffmpeg за замовчуванням).
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"

static AVCodecContext *ctx;
static AVPacket *pkt;
static AVFrame *frame;
static uint8_t *input;
static int input_cap;
static uint8_t *rgba;
static int width, height;

EMSCRIPTEN_KEEPALIVE int iv_open(int w, int h) {
  const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_INDEO5);
  if (!codec) return -1;
  ctx = avcodec_alloc_context3(codec);
  ctx->width = w;
  ctx->height = h;
  if (avcodec_open2(ctx, codec, NULL) < 0) return -2;
  pkt = av_packet_alloc();
  frame = av_frame_alloc();
  width = w;
  height = h;
  rgba = malloc((size_t)w * h * 4);
  return 0;
}

/** Буфер під стиснений кадр розміром size (з запасом, якого вимагає libavcodec). */
EMSCRIPTEN_KEEPALIVE uint8_t *iv_input(int size) {
  if (size + AV_INPUT_BUFFER_PADDING_SIZE > input_cap) {
    free(input);
    input_cap = size + AV_INPUT_BUFFER_PADDING_SIZE;
    input = malloc(input_cap);
  }
  memset(input + size, 0, AV_INPUT_BUFFER_PADDING_SIZE);
  return input;
}

static uint8_t clip(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

static void to_rgba(void) {
  const int w = frame->width < width ? frame->width : width;
  const int h = frame->height < height ? frame->height : height;
  for (int y = 0; y < h; y++) {
    const uint8_t *py = frame->data[0] + y * frame->linesize[0];
    const uint8_t *pu = frame->data[1] + (y >> 2) * frame->linesize[1];
    const uint8_t *pv = frame->data[2] + (y >> 2) * frame->linesize[2];
    uint8_t *o = rgba + (size_t)y * width * 4;
    for (int x = 0; x < w; x++) {
      const int c = (py[x] - 16) * 298, d = pu[x >> 2] - 128, e = pv[x >> 2] - 128;
      o[0] = clip((c + 409 * e + 128) >> 8);
      o[1] = clip((c - 100 * d - 208 * e + 128) >> 8);
      o[2] = clip((c + 516 * d + 128) >> 8);
      o[3] = 255;
      o += 4;
    }
  }
}

/** Декодувати кадр size байтів з iv_input: 1 — є новий кадр у iv_rgba, 0 — ні (порожній кадр), < 0 — помилка. */
EMSCRIPTEN_KEEPALIVE int iv_decode(int size) {
  pkt->data = input;
  pkt->size = size;
  int r = avcodec_send_packet(ctx, pkt);
  if (r < 0) return r;
  r = avcodec_receive_frame(ctx, frame);
  if (r == AVERROR(EAGAIN)) return 0;
  if (r < 0) return r;
  to_rgba();
  av_frame_unref(frame);
  return 1;
}

EMSCRIPTEN_KEEPALIVE uint8_t *iv_rgba(void) { return rgba; }

EMSCRIPTEN_KEEPALIVE void iv_close(void) {
  avcodec_free_context(&ctx);
  av_packet_free(&pkt);
  av_frame_free(&frame);
  free(input);
  free(rgba);
  input = rgba = NULL;
  input_cap = 0;
}
