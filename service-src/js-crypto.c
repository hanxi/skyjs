/*
 * js-crypto.c -- Pure C crypto module for SkyJS (ArrayBuffer I/O).
 * Port: SHA1 from lsha1.c, DES/MD5/DH/base64/hex from lua-crypt.c.
 * New: SHA256/SHA512 (FIPS 180-4), HMAC-SHA1/SHA256/SHA512 (RFC 2104).
 * Registered as skynetcore.crypt namespace.
 */
#include <quickjs.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include "skynet.h"
#include "snjs-internal.h"
#ifdef __linux__
#include <sys/random.h>
#endif
#if defined(_WIN32)
/* rand_s() needs _CRT_RAND_S defined before <stdlib.h>, but on MinGW the forced
 * compat header pulls <stdlib.h> in first, so declare the msvcrt prototype
 * directly instead (links without any extra library). */
int rand_s(unsigned int *);
#endif

#define SMALL_CHUNK 256

/* ================================================================
 * SHA-1  (ported from lsha1.c, 100% Public Domain by Steve Reid)
 * ================================================================ */
#define SHA1_DIGEST_SIZE 20
#define SHA1_BLOCK_SIZE 64
typedef struct { uint32_t state[5]; uint32_t count[2]; uint8_t buffer[64]; } SHA1_CTX;

#define sha1_rol(v,b) (((v)<<(b))|((v)>>(32-(b))))
#ifdef WORDS_BIGENDIAN
#define sha1_blk0(i) block.l[i]
#else
#define sha1_blk0(i) (block.l[i]=(sha1_rol(block.l[i],24)&0xFF00FF00)|(sha1_rol(block.l[i],8)&0x00FF00FF))
#endif
#define sha1_blk(i) (block.l[i&15]=sha1_rol(block.l[(i+13)&15]^block.l[(i+8)&15]^block.l[(i+2)&15]^block.l[i&15],1))
#define S1R0(v,w,x,y,z,i) z+=((w&(x^y))^y)+sha1_blk0(i)+0x5A827999+sha1_rol(v,5);w=sha1_rol(w,30);
#define S1R1(v,w,x,y,z,i) z+=((w&(x^y))^y)+sha1_blk(i)+0x5A827999+sha1_rol(v,5);w=sha1_rol(w,30);
#define S1R2(v,w,x,y,z,i) z+=(w^x^y)+sha1_blk(i)+0x6ED9EBA1+sha1_rol(v,5);w=sha1_rol(w,30);
#define S1R3(v,w,x,y,z,i) z+=(((w|x)&y)|(w&x))+sha1_blk(i)+0x8F1BBCDC+sha1_rol(v,5);w=sha1_rol(w,30);
#define S1R4(v,w,x,y,z,i) z+=(w^x^y)+sha1_blk(i)+0xCA62C1D6+sha1_rol(v,5);w=sha1_rol(w,30);

static void SHA1_Transform(uint32_t state[5], const uint8_t buffer[64]) {
	uint32_t a,b,c,d,e;
	typedef union { uint8_t c[64]; uint32_t l[16]; } CHAR64LONG16;
	CHAR64LONG16 block; memcpy(&block, buffer, 64);
	a=state[0];b=state[1];c=state[2];d=state[3];e=state[4];
	S1R0(a,b,c,d,e, 0);S1R0(e,a,b,c,d, 1);S1R0(d,e,a,b,c, 2);S1R0(c,d,e,a,b, 3);
	S1R0(b,c,d,e,a, 4);S1R0(a,b,c,d,e, 5);S1R0(e,a,b,c,d, 6);S1R0(d,e,a,b,c, 7);
	S1R0(c,d,e,a,b, 8);S1R0(b,c,d,e,a, 9);S1R0(a,b,c,d,e,10);S1R0(e,a,b,c,d,11);
	S1R0(d,e,a,b,c,12);S1R0(c,d,e,a,b,13);S1R0(b,c,d,e,a,14);S1R0(a,b,c,d,e,15);
	S1R1(e,a,b,c,d,16);S1R1(d,e,a,b,c,17);S1R1(c,d,e,a,b,18);S1R1(b,c,d,e,a,19);
	S1R2(a,b,c,d,e,20);S1R2(e,a,b,c,d,21);S1R2(d,e,a,b,c,22);S1R2(c,d,e,a,b,23);
	S1R2(b,c,d,e,a,24);S1R2(a,b,c,d,e,25);S1R2(e,a,b,c,d,26);S1R2(d,e,a,b,c,27);
	S1R2(c,d,e,a,b,28);S1R2(b,c,d,e,a,29);S1R2(a,b,c,d,e,30);S1R2(e,a,b,c,d,31);
	S1R2(d,e,a,b,c,32);S1R2(c,d,e,a,b,33);S1R2(b,c,d,e,a,34);S1R2(a,b,c,d,e,35);
	S1R2(e,a,b,c,d,36);S1R2(d,e,a,b,c,37);S1R2(c,d,e,a,b,38);S1R2(b,c,d,e,a,39);
	S1R3(a,b,c,d,e,40);S1R3(e,a,b,c,d,41);S1R3(d,e,a,b,c,42);S1R3(c,d,e,a,b,43);
	S1R3(b,c,d,e,a,44);S1R3(a,b,c,d,e,45);S1R3(e,a,b,c,d,46);S1R3(d,e,a,b,c,47);
	S1R3(c,d,e,a,b,48);S1R3(b,c,d,e,a,49);S1R3(a,b,c,d,e,50);S1R3(e,a,b,c,d,51);
	S1R3(d,e,a,b,c,52);S1R3(c,d,e,a,b,53);S1R3(b,c,d,e,a,54);S1R3(a,b,c,d,e,55);
	S1R3(e,a,b,c,d,56);S1R3(d,e,a,b,c,57);S1R3(c,d,e,a,b,58);S1R3(b,c,d,e,a,59);
	S1R4(a,b,c,d,e,60);S1R4(e,a,b,c,d,61);S1R4(d,e,a,b,c,62);S1R4(c,d,e,a,b,63);
	S1R4(b,c,d,e,a,64);S1R4(a,b,c,d,e,65);S1R4(e,a,b,c,d,66);S1R4(d,e,a,b,c,67);
	S1R4(c,d,e,a,b,68);S1R4(b,c,d,e,a,69);S1R4(a,b,c,d,e,70);S1R4(e,a,b,c,d,71);
	S1R4(d,e,a,b,c,72);S1R4(c,d,e,a,b,73);S1R4(b,c,d,e,a,74);S1R4(a,b,c,d,e,75);
	S1R4(e,a,b,c,d,76);S1R4(d,e,a,b,c,77);S1R4(c,d,e,a,b,78);S1R4(b,c,d,e,a,79);
	state[0]+=a;state[1]+=b;state[2]+=c;state[3]+=d;state[4]+=e;
}

static void sha1_init(SHA1_CTX *c) {
	c->state[0]=0x67452301;c->state[1]=0xEFCDAB89;c->state[2]=0x98BADCFE;
	c->state[3]=0x10325476;c->state[4]=0xC3D2E1F0;
	c->count[0]=c->count[1]=0;
}
static void sha1_update(SHA1_CTX *c, const uint8_t *data, size_t len) {
	size_t i,j;
	j=(c->count[0]>>3)&63;
	if ((c->count[0]+=(uint32_t)(len<<3))<(uint32_t)(len<<3)) c->count[1]++;
	c->count[1]+=(uint32_t)(len>>29);
	if ((j+len)>63) {
		memcpy(&c->buffer[j],data,(i=64-j));
		SHA1_Transform(c->state,c->buffer);
		for (;i+63<len;i+=64) SHA1_Transform(c->state,data+i);
		j=0;
	} else i=0;
	memcpy(&c->buffer[j],&data[i],len-i);
}
static void sha1_final(SHA1_CTX *c, uint8_t digest[20]) {
	uint32_t i; uint8_t fc[8];
	for (i=0;i<8;i++) fc[i]=(uint8_t)((c->count[(i>=4?0:1)]>>((3-(i&3))*8))&255);
	sha1_update(c,(uint8_t*)"\200",1);
	while ((c->count[0]&504)!=448) sha1_update(c,(uint8_t*)"\0",1);
	sha1_update(c,fc,8);
	for (i=0;i<20;i++) digest[i]=(uint8_t)((c->state[i>>2]>>((3-(i&3))*8))&255);
}

/* ================================================================
 * SHA-256  (FIPS 180-4)
 * ================================================================ */
static const uint32_t sha256_K[64] = {
	0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
	0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
	0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
	0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
	0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
	0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
	0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
	0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
typedef struct { uint32_t state[8]; uint64_t count; uint8_t buffer[64]; } SHA256_CTX;

static inline uint32_t s256_rotr(uint32_t x,int n){return (x>>n)|(x<<(32-n));}
static inline uint32_t s256_ch(uint32_t x,uint32_t y,uint32_t z){return (x&y)^(~x&z);}
static inline uint32_t s256_maj(uint32_t x,uint32_t y,uint32_t z){return (x&y)^(x&z)^(y&z);}
static inline uint32_t s256_S0(uint32_t x){return s256_rotr(x,2)^s256_rotr(x,13)^s256_rotr(x,22);}
static inline uint32_t s256_S1(uint32_t x){return s256_rotr(x,6)^s256_rotr(x,11)^s256_rotr(x,25);}
static inline uint32_t s256_s0(uint32_t x){return s256_rotr(x,7)^s256_rotr(x,18)^(x>>3);}
static inline uint32_t s256_s1(uint32_t x){return s256_rotr(x,17)^s256_rotr(x,19)^(x>>10);}

static void sha256_transform(uint32_t state[8], const uint8_t blk[64]) {
	uint32_t W[64], a,b,c,d,e,f,g,h,t1,t2;
	int i;
	for (i=0;i<16;i++) W[i]=(uint32_t)blk[i*4]<<24|(uint32_t)blk[i*4+1]<<16|(uint32_t)blk[i*4+2]<<8|blk[i*4+3];
	for (i=16;i<64;i++) W[i]=s256_s1(W[i-2])+W[i-7]+s256_s0(W[i-15])+W[i-16];
	a=state[0];b=state[1];c=state[2];d=state[3];e=state[4];f=state[5];g=state[6];h=state[7];
	for (i=0;i<64;i++) {
		t1=h+s256_S1(e)+s256_ch(e,f,g)+sha256_K[i]+W[i];
		t2=s256_S0(a)+s256_maj(a,b,c);
		h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
	}
	state[0]+=a;state[1]+=b;state[2]+=c;state[3]+=d;state[4]+=e;state[5]+=f;state[6]+=g;state[7]+=h;
}
static void sha256_init(SHA256_CTX *c) {
	c->state[0]=0x6a09e667;c->state[1]=0xbb67ae85;c->state[2]=0x3c6ef372;c->state[3]=0xa54ff53a;
	c->state[4]=0x510e527f;c->state[5]=0x9b05688c;c->state[6]=0x1f83d9ab;c->state[7]=0x5be0cd19;
	c->count=0;
}
static void sha256_update(SHA256_CTX *c, const uint8_t *data, size_t len) {
	size_t i=0, idx=(size_t)(c->count&0x3f);
	c->count+=len;
	if (idx+len>=64) {
		memcpy(c->buffer+idx,data,64-idx); sha256_transform(c->state,c->buffer);
		for (i=64-idx;i+63<len;i+=64) sha256_transform(c->state,data+i);
		idx=0;
	}
	memcpy(c->buffer+idx,data+i,len-i);
}
static void sha256_final(SHA256_CTX *c, uint8_t digest[32]) {
	uint64_t bits=c->count*8; size_t idx=(size_t)(c->count&0x3f); int i;
	c->buffer[idx++]=0x80;
	if (idx>56) { memset(c->buffer+idx,0,64-idx); sha256_transform(c->state,c->buffer); idx=0; }
	memset(c->buffer+idx,0,56-idx);
	for (i=0;i<8;i++) c->buffer[56+i]=(uint8_t)(bits>>(56-i*8));
	sha256_transform(c->state,c->buffer);
	for (i=0;i<8;i++){digest[i*4]=(uint8_t)(c->state[i]>>24);digest[i*4+1]=(uint8_t)(c->state[i]>>16);
		digest[i*4+2]=(uint8_t)(c->state[i]>>8);digest[i*4+3]=(uint8_t)c->state[i];}
}

/* ================================================================
 * SHA-512  (FIPS 180-4)
 * ================================================================ */
static const uint64_t sha512_K[80] = {
	0x428a2f98d728ae22ULL,0x7137449123ef65cdULL,0xb5c0fbcfec4d3b2fULL,0xe9b5dba58189dbbcULL,
	0x3956c25bf348b538ULL,0x59f111f1b605d019ULL,0x923f82a4af194f9bULL,0xab1c5ed5da6d8118ULL,
	0xd807aa98a3030242ULL,0x12835b0145706fbeULL,0x243185be4ee4b28cULL,0x550c7dc3d5ffb4e2ULL,
	0x72be5d74f27b896fULL,0x80deb1fe3b1696b1ULL,0x9bdc06a725c71235ULL,0xc19bf174cf692694ULL,
	0xe49b69c19ef14ad2ULL,0xefbe4786384f25e3ULL,0x0fc19dc68b8cd5b5ULL,0x240ca1cc77ac9c65ULL,
	0x2de92c6f592b0275ULL,0x4a7484aa6ea6e483ULL,0x5cb0a9dcbd41fbd4ULL,0x76f988da831153b5ULL,
	0x983e5152ee66dfabULL,0xa831c66d2db43210ULL,0xb00327c898fb213fULL,0xbf597fc7beef0ee4ULL,
	0xc6e00bf33da88fc2ULL,0xd5a79147930aa725ULL,0x06ca6351e003826fULL,0x142929670a0e6e70ULL,
	0x27b70a8546d22ffcULL,0x2e1b21385c26c926ULL,0x4d2c6dfc5ac42aedULL,0x53380d139d95b3dfULL,
	0x650a73548baf63deULL,0x766a0abb3c77b2a8ULL,0x81c2c92e47edaee6ULL,0x92722c851482353bULL,
	0xa2bfe8a14cf10364ULL,0xa81a664bbc423001ULL,0xc24b8b70d0f89791ULL,0xc76c51a30654be30ULL,
	0xd192e819d6ef5218ULL,0xd69906245565a910ULL,0xf40e35855771202aULL,0x106aa07032bbd1b8ULL,
	0x19a4c116b8d2d0c8ULL,0x1e376c085141ab53ULL,0x2748774cdf8eeb99ULL,0x34b0bcb5e19b48a8ULL,
	0x391c0cb3c5c95a63ULL,0x4ed8aa4ae3418acbULL,0x5b9cca4f7763e373ULL,0x682e6ff3d6b2b8a3ULL,
	0x748f82ee5defb2fcULL,0x78a5636f43172f60ULL,0x84c87814a1f0ab72ULL,0x8cc702081a6439ecULL,
	0x90befffa23631e28ULL,0xa4506cebde82bde9ULL,0xbef9a3f7b2c67915ULL,0xc67178f2e372532bULL,
	0xca273eceea26619cULL,0xd186b8c721c0c207ULL,0xeada7dd6cde0eb1eULL,0xf57d4f7fee6ed178ULL,
	0x06f067aa72176fbaULL,0x0a637dc5a2c898a6ULL,0x113f9804bef90daeULL,0x1b710b35131c471bULL,
	0x28db77f523047d84ULL,0x32caab7b40c72493ULL,0x3c9ebe0a15c9bebcULL,0x431d67c49c100d4cULL,
	0x4cc5d4becb3e42b6ULL,0x597f299cfc657e2aULL,0x5fcb6fab3ad6faecULL,0x6c44198c4a475817ULL};
typedef struct { uint64_t state[8]; uint64_t count[2]; uint8_t buffer[128]; } SHA512_CTX;

static inline uint64_t s512_rotr(uint64_t x,int n){return (x>>n)|(x<<(64-n));}
static inline uint64_t s512_ch(uint64_t x,uint64_t y,uint64_t z){return (x&y)^(~x&z);}
static inline uint64_t s512_maj(uint64_t x,uint64_t y,uint64_t z){return (x&y)^(x&z)^(y&z);}
static inline uint64_t s512_S0(uint64_t x){return s512_rotr(x,28)^s512_rotr(x,34)^s512_rotr(x,39);}
static inline uint64_t s512_S1(uint64_t x){return s512_rotr(x,14)^s512_rotr(x,18)^s512_rotr(x,41);}
static inline uint64_t s512_s0(uint64_t x){return s512_rotr(x,1)^s512_rotr(x,8)^(x>>7);}
static inline uint64_t s512_s1(uint64_t x){return s512_rotr(x,19)^s512_rotr(x,61)^(x>>6);}

static void sha512_transform(uint64_t state[8], const uint8_t blk[128]) {
	uint64_t W[80],a,b,c,d,e,f,g,h,t1,t2; int i;
	for (i=0;i<16;i++) W[i]=(uint64_t)blk[i*8]<<56|(uint64_t)blk[i*8+1]<<48|(uint64_t)blk[i*8+2]<<40|
		(uint64_t)blk[i*8+3]<<32|(uint64_t)blk[i*8+4]<<24|(uint64_t)blk[i*8+5]<<16|
		(uint64_t)blk[i*8+6]<<8|blk[i*8+7];
	for (i=16;i<80;i++) W[i]=s512_s1(W[i-2])+W[i-7]+s512_s0(W[i-15])+W[i-16];
	a=state[0];b=state[1];c=state[2];d=state[3];e=state[4];f=state[5];g=state[6];h=state[7];
	for (i=0;i<80;i++) {
		t1=h+s512_S1(e)+s512_ch(e,f,g)+sha512_K[i]+W[i];
		t2=s512_S0(a)+s512_maj(a,b,c);
		h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
	}
	state[0]+=a;state[1]+=b;state[2]+=c;state[3]+=d;state[4]+=e;state[5]+=f;state[6]+=g;state[7]+=h;
}
static void sha512_init(SHA512_CTX *c) {
	c->state[0]=0x6a09e667f3bcc908ULL;c->state[1]=0xbb67ae8584caa73bULL;
	c->state[2]=0x3c6ef372fe94f82bULL;c->state[3]=0xa54ff53a5f1d36f1ULL;
	c->state[4]=0x510e527fade682d1ULL;c->state[5]=0x9b05688c2b3e6c1fULL;
	c->state[6]=0x1f83d9abfb41bd6bULL;c->state[7]=0x5be0cd19137e2179ULL;
	c->count[0]=c->count[1]=0;
}
static void sha512_update(SHA512_CTX *c, const uint8_t *data, size_t len) {
	size_t i=0, idx=(size_t)(c->count[0]&0x7f);
	uint64_t old=c->count[0]; c->count[0]+=len;
	if (c->count[0]<old) c->count[1]++;
	if (idx+len>=128) {
		memcpy(c->buffer+idx,data,128-idx); sha512_transform(c->state,c->buffer);
		for (i=128-idx;i+127<len;i+=128) sha512_transform(c->state,data+i);
		idx=0;
	}
	memcpy(c->buffer+idx,data+i,len-i);
}
static void sha512_final(SHA512_CTX *c, uint8_t digest[64]) {
	uint64_t blo=c->count[0]*8, bhi=c->count[1]*8+(c->count[0]>>61);
	size_t idx=(size_t)(c->count[0]&0x7f); int i;
	c->buffer[idx++]=0x80;
	if (idx>112){memset(c->buffer+idx,0,128-idx);sha512_transform(c->state,c->buffer);idx=0;}
	memset(c->buffer+idx,0,112-idx);
	for (i=0;i<8;i++) c->buffer[112+i]=(uint8_t)(bhi>>(56-i*8));
	for (i=0;i<8;i++) c->buffer[120+i]=(uint8_t)(blo>>(56-i*8));
	sha512_transform(c->state,c->buffer);
	for (i=0;i<8;i++){int j;for(j=0;j<8;j++) digest[i*8+j]=(uint8_t)(c->state[i]>>(56-j*8));}
}

/* ================================================================
 * HMAC  (RFC 2104) — generic macro, instantiated for SHA1/256/512
 * ================================================================ */
#define HMAC_IMPL(name,CTX,init_fn,update_fn,final_fn,BLOCK,DIGEST) \
static void name(const uint8_t *key,size_t klen,const uint8_t *data,size_t dlen,uint8_t *out){\
	CTX ictx,octx; uint8_t rkey[BLOCK]; int _i;\
	memset(rkey,0,BLOCK);\
	if(klen>(size_t)BLOCK){CTX kc;init_fn(&kc);update_fn(&kc,key,klen);final_fn(&kc,rkey);}else{memcpy(rkey,key,klen);}\
	uint8_t pad[BLOCK];\
	for(_i=0;_i<BLOCK;_i++) pad[_i]=rkey[_i]^0x36;\
	init_fn(&ictx);update_fn(&ictx,pad,BLOCK);update_fn(&ictx,data,dlen);\
	uint8_t inner[DIGEST]; final_fn(&ictx,inner);\
	for(_i=0;_i<BLOCK;_i++) pad[_i]=rkey[_i]^0x5c;\
	init_fn(&octx);update_fn(&octx,pad,BLOCK);update_fn(&octx,inner,DIGEST);\
	final_fn(&octx,out);\
}
HMAC_IMPL(hmac_sha1,SHA1_CTX,sha1_init,sha1_update,sha1_final,64,SHA1_DIGEST_SIZE)
HMAC_IMPL(hmac_sha256,SHA256_CTX,sha256_init,sha256_update,sha256_final,64,32)
HMAC_IMPL(hmac_sha512,SHA512_CTX,sha512_init,sha512_update,sha512_final,128,64)

/* ================================================================
 * MD5  (internal, ported from lua-crypt.c — used by hmac64/hmac64_md5)
 * ================================================================ */
static const uint32_t md5_K[64] = {
	0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
	0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
	0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
	0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
	0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
	0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
	0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
	0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391};
static const uint32_t md5_R[] = {
	7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
	5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
	4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
	6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21};
#define MD5_LEFTROTATE(x,c) (((x)<<(c))|((x)>>(32-(c))))

static void digest_md5(uint32_t w[16], uint32_t result[4]) {
	uint32_t a=0x67452301u,b=0xefcdab89u,c=0x98badcfeu,d=0x10325476u,fi,g,temp; int i;
	for (i=0;i<64;i++){
		if(i<16){fi=(b&c)|((~b)&d);g=i;}
		else if(i<32){fi=(d&b)|((~d)&c);g=(5*i+1)%16;}
		else if(i<48){fi=b^c^d;g=(3*i+5)%16;}
		else{fi=c^(b|(~d));g=(7*i)%16;}
		temp=d;d=c;c=b;b=b+MD5_LEFTROTATE((a+fi+md5_K[i]+w[g]),md5_R[i]);a=temp;
	}
	result[0]=a;result[1]=b;result[2]=c;result[3]=d;
}

/* hmac64 internals (ported from lua-crypt.c) */
static void read_u64_le(const uint8_t *p, uint32_t out[2]) {
	out[0]=p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;
	out[1]=p[4]|(uint32_t)p[5]<<8|(uint32_t)p[6]<<16|(uint32_t)p[7]<<24;
}
static void write_u64_le(uint32_t v[2], uint8_t out[8]) {
	out[0]=v[0]&0xff;out[1]=(v[0]>>8)&0xff;out[2]=(v[0]>>16)&0xff;out[3]=(v[0]>>24)&0xff;
	out[4]=v[1]&0xff;out[5]=(v[1]>>8)&0xff;out[6]=(v[1]>>16)&0xff;out[7]=(v[1]>>24)&0xff;
}
static void crypt_hmac64(uint32_t x[2], uint32_t y[2], uint32_t result[2]) {
	uint32_t w[16],r[4]; int i;
	for (i=0;i<16;i+=4){w[i]=x[1];w[i+1]=x[0];w[i+2]=y[1];w[i+3]=y[0];}
	digest_md5(w,r);
	result[0]=r[2]^r[3]; result[1]=r[0]^r[1];
}
static void crypt_hmac64_md5(uint32_t x[2], uint32_t y[2], uint32_t result[2]) {
	uint32_t w[16],r[4]; int i;
	for (i=0;i<12;i+=4){w[i]=x[0];w[i+1]=x[1];w[i+2]=y[0];w[i+3]=y[1];}
	w[12]=0x80;w[13]=0;w[14]=384;w[15]=0;
	digest_md5(w,r);
	result[0]=(r[0]+0x67452301u)^(r[2]+0x98badcfeu);
	result[1]=(r[1]+0xefcdab89u)^(r[3]+0x10325476u);
}

/* ================================================================
 * DES  (ported from lua-crypt.c)
 * ================================================================ */
static const uint32_t SB1[64]={
	0x01010400,0x00000000,0x00010000,0x01010404,0x01010004,0x00010404,0x00000004,0x00010000,
	0x00000400,0x01010400,0x01010404,0x00000400,0x01000404,0x01010004,0x01000000,0x00000004,
	0x00000404,0x01000400,0x01000400,0x00010400,0x00010400,0x01010000,0x01010000,0x01000404,
	0x00010004,0x01000004,0x01000004,0x00010004,0x00000000,0x00000404,0x00010404,0x01000000,
	0x00010000,0x01010404,0x00000004,0x01010000,0x01010400,0x01000000,0x01000000,0x00000400,
	0x01010004,0x00010000,0x00010400,0x01000004,0x00000400,0x00000004,0x01000404,0x00010404,
	0x01010404,0x00010004,0x01010000,0x01000404,0x01000004,0x00000404,0x00010404,0x01010400,
	0x00000404,0x01000400,0x01000400,0x00000000,0x00010004,0x00010400,0x00000000,0x01010004};
static const uint32_t SB2[64]={
	0x80108020,0x80008000,0x00008000,0x00108020,0x00100000,0x00000020,0x80100020,0x80008020,
	0x80000020,0x80108020,0x80108000,0x80000000,0x80008000,0x00100000,0x00000020,0x80100020,
	0x00108000,0x00100020,0x80008020,0x00000000,0x80000000,0x00008000,0x00108020,0x80100000,
	0x00100020,0x80000020,0x00000000,0x00108000,0x00008020,0x80108000,0x80100000,0x00008020,
	0x00000000,0x00108020,0x80100020,0x00100000,0x80008020,0x80100000,0x80108000,0x00008000,
	0x80100000,0x80008000,0x00000020,0x80108020,0x00108020,0x00000020,0x00008000,0x80000000,
	0x00008020,0x80108000,0x00100000,0x80000020,0x00100020,0x80008020,0x80000020,0x00100020,
	0x00108000,0x00000000,0x80008000,0x00008020,0x80000000,0x80100020,0x80108020,0x00108000};
static const uint32_t SB3[64]={
	0x00000208,0x08020200,0x00000000,0x08020008,0x08000200,0x00000000,0x00020208,0x08000200,
	0x00020008,0x08000008,0x08000008,0x00020000,0x08020208,0x00020008,0x08020000,0x00000208,
	0x08000000,0x00000008,0x08020200,0x00000200,0x00020200,0x08020000,0x08020008,0x00020208,
	0x08000208,0x00020200,0x00020000,0x08000208,0x00000008,0x08020208,0x00000200,0x08000000,
	0x08020200,0x08000000,0x00020008,0x00000208,0x00020000,0x08020200,0x08000200,0x00000000,
	0x00000200,0x00020008,0x08020208,0x08000200,0x08000008,0x00000200,0x00000000,0x08020008,
	0x08000208,0x00020000,0x08000000,0x08020208,0x00000008,0x00020208,0x00020200,0x08000008,
	0x08020000,0x08000208,0x00000208,0x08020000,0x00020208,0x00000008,0x08020008,0x00020200};
static const uint32_t SB4[64]={
	0x00802001,0x00002081,0x00002081,0x00000080,0x00802080,0x00800081,0x00800001,0x00002001,
	0x00000000,0x00802000,0x00802000,0x00802081,0x00000081,0x00000000,0x00800080,0x00800001,
	0x00000001,0x00002000,0x00800000,0x00802001,0x00000080,0x00800000,0x00002001,0x00002080,
	0x00800081,0x00000001,0x00002080,0x00800080,0x00002000,0x00802080,0x00802081,0x00000081,
	0x00800080,0x00800001,0x00802000,0x00802081,0x00000081,0x00000000,0x00000000,0x00802000,
	0x00002080,0x00800080,0x00800081,0x00000001,0x00802001,0x00002081,0x00002081,0x00000080,
	0x00802081,0x00000081,0x00000001,0x00002000,0x00800001,0x00002001,0x00802080,0x00800081,
	0x00002001,0x00002080,0x00800000,0x00802001,0x00000080,0x00800000,0x00002000,0x00802080};
static const uint32_t SB5[64]={
	0x00000100,0x02080100,0x02080000,0x42000100,0x00080000,0x00000100,0x40000000,0x02080000,
	0x40080100,0x00080000,0x02000100,0x40080100,0x42000100,0x42080000,0x00080100,0x40000000,
	0x02000000,0x40080000,0x40080000,0x00000000,0x40000100,0x42080100,0x42080100,0x02000100,
	0x42080000,0x40000100,0x00000000,0x42000000,0x02080100,0x02000000,0x42000000,0x00080100,
	0x00080000,0x42000100,0x00000100,0x02000000,0x40000000,0x02080000,0x42000100,0x40080100,
	0x02000100,0x40000000,0x42080000,0x02080100,0x40080100,0x00000100,0x02000000,0x42080000,
	0x42080100,0x00080100,0x42000000,0x42080100,0x02080000,0x00000000,0x40080000,0x42000000,
	0x00080100,0x02000100,0x40000100,0x00080000,0x00000000,0x40080000,0x02080100,0x40000100};
static const uint32_t SB6[64]={
	0x20000010,0x20400000,0x00004000,0x20404010,0x20400000,0x00000010,0x20404010,0x00400000,
	0x20004000,0x00404010,0x00400000,0x20000010,0x00400010,0x20004000,0x20000000,0x00004010,
	0x00000000,0x00400010,0x20004010,0x00004000,0x00404000,0x20004010,0x00000010,0x20400010,
	0x20400010,0x00000000,0x00404010,0x20404000,0x00004010,0x00404000,0x20404000,0x20000000,
	0x20004000,0x00000010,0x20400010,0x00404000,0x20404010,0x00400000,0x00004010,0x20000010,
	0x00400000,0x20004000,0x20000000,0x00004010,0x20000010,0x20404010,0x00404000,0x20400000,
	0x00404010,0x20404000,0x00000000,0x20400010,0x00000010,0x00004000,0x20400000,0x00404010,
	0x00004000,0x00400010,0x20004010,0x00000000,0x20404000,0x20000000,0x00400010,0x20004010};
static const uint32_t SB7[64]={
	0x00200000,0x04200002,0x04000802,0x00000000,0x00000800,0x04000802,0x00200802,0x04200800,
	0x04200802,0x00200000,0x00000000,0x04000002,0x00000002,0x04000000,0x04200002,0x00000802,
	0x04000800,0x00200802,0x00200002,0x04000800,0x04000002,0x04200000,0x04200800,0x00200002,
	0x04200000,0x00000800,0x00000802,0x04200802,0x00200800,0x00000002,0x04000000,0x00200800,
	0x04000000,0x00200800,0x00200000,0x04000802,0x04000802,0x04200002,0x04200002,0x00000002,
	0x00200002,0x04000000,0x04000800,0x00200000,0x04200800,0x00000802,0x00200802,0x04200800,
	0x00000802,0x04000002,0x04200802,0x04200000,0x00200800,0x00000000,0x00000002,0x04200802,
	0x00000000,0x00200802,0x04200000,0x00000800,0x04000002,0x04000800,0x00000800,0x00200002};
static const uint32_t SB8[64]={
	0x10001040,0x00001000,0x00040000,0x10041040,0x10000000,0x10001040,0x00000040,0x10000000,
	0x00040040,0x10040000,0x10041040,0x00041000,0x10041000,0x00041040,0x00001000,0x00000040,
	0x10040000,0x10000040,0x10001000,0x00001040,0x00041000,0x00040040,0x10040040,0x10041000,
	0x00001040,0x00000000,0x00000000,0x10040040,0x10000040,0x10001000,0x00041040,0x00040000,
	0x00041040,0x00040000,0x10041000,0x00001000,0x00000040,0x10040040,0x00001000,0x00041040,
	0x10001000,0x00000040,0x10000040,0x10040000,0x10040040,0x10000000,0x00040000,0x10001040,
	0x00000000,0x10041040,0x00040040,0x10000040,0x10040000,0x10001000,0x10001040,0x00000000,
	0x10041040,0x00041000,0x00041000,0x00001040,0x00001040,0x00040040,0x10000000,0x10041000};
static const uint32_t LHs[16]={
	0x00000000,0x00000001,0x00000100,0x00000101,0x00010000,0x00010001,0x00010100,0x00010101,
	0x01000000,0x01000001,0x01000100,0x01000101,0x01010000,0x01010001,0x01010100,0x01010101};
static const uint32_t RHs[16]={
	0x00000000,0x01000000,0x00010000,0x01010000,0x00000100,0x01000100,0x00010100,0x01010100,
	0x00000001,0x01000001,0x00010001,0x01010001,0x00000101,0x01000101,0x00010101,0x01010101};

#define DES_GET_UINT32(n,b,i) {(n)=((uint32_t)(b)[(i)]<<24)|((uint32_t)(b)[(i)+1]<<16)|((uint32_t)(b)[(i)+2]<<8)|(uint32_t)(b)[(i)+3];}
#define DES_PUT_UINT32(n,b,i) {(b)[(i)]=(uint8_t)((n)>>24);(b)[(i)+1]=(uint8_t)((n)>>16);(b)[(i)+2]=(uint8_t)((n)>>8);(b)[(i)+3]=(uint8_t)(n);}

#define DES_IP(X,Y) {\
	T=((X>>4)^Y)&0x0F0F0F0F;Y^=T;X^=(T<<4);\
	T=((X>>16)^Y)&0x0000FFFF;Y^=T;X^=(T<<16);\
	T=((Y>>2)^X)&0x33333333;X^=T;Y^=(T<<2);\
	T=((Y>>8)^X)&0x00FF00FF;X^=T;Y^=(T<<8);\
	Y=((Y<<1)|(Y>>31))&0xFFFFFFFF;\
	T=(X^Y)&0xAAAAAAAA;Y^=T;X^=T;\
	X=((X<<1)|(X>>31))&0xFFFFFFFF;}

#define DES_FP(X,Y) {\
	X=((X<<31)|(X>>1))&0xFFFFFFFF;\
	T=(X^Y)&0xAAAAAAAA;X^=T;Y^=T;\
	Y=((Y<<31)|(Y>>1))&0xFFFFFFFF;\
	T=((Y>>8)^X)&0x00FF00FF;X^=T;Y^=(T<<8);\
	T=((Y>>2)^X)&0x33333333;X^=T;Y^=(T<<2);\
	T=((X>>16)^Y)&0x0000FFFF;Y^=T;X^=(T<<16);\
	T=((X>>4)^Y)&0x0F0F0F0F;Y^=T;X^=(T<<4);}

#define DES_ROUND(X,Y) {\
	T=*SK++^X;\
	Y^=SB8[(T)&0x3F]^SB6[(T>>8)&0x3F]^SB4[(T>>16)&0x3F]^SB2[(T>>24)&0x3F];\
	T=*SK++^((X<<28)|(X>>4));\
	Y^=SB7[(T)&0x3F]^SB5[(T>>8)&0x3F]^SB3[(T>>16)&0x3F]^SB1[(T>>24)&0x3F];}

static void des_main_ks(uint32_t SK[32], const uint8_t key[8]) {
	int i; uint32_t X,Y,T;
	DES_GET_UINT32(X,key,0); DES_GET_UINT32(Y,key,4);
	T=((Y>>4)^X)&0x0F0F0F0F;X^=T;Y^=(T<<4);
	T=((Y)^X)&0x10101010;X^=T;Y^=(T);
	X=(LHs[(X)&0xF]<<3)|(LHs[(X>>8)&0xF]<<2)|(LHs[(X>>16)&0xF]<<1)|(LHs[(X>>24)&0xF])
	 |(LHs[(X>>5)&0xF]<<7)|(LHs[(X>>13)&0xF]<<6)|(LHs[(X>>21)&0xF]<<5)|(LHs[(X>>29)&0xF]<<4);
	Y=(RHs[(Y>>1)&0xF]<<3)|(RHs[(Y>>9)&0xF]<<2)|(RHs[(Y>>17)&0xF]<<1)|(RHs[(Y>>25)&0xF])
	 |(RHs[(Y>>4)&0xF]<<7)|(RHs[(Y>>12)&0xF]<<6)|(RHs[(Y>>20)&0xF]<<5)|(RHs[(Y>>28)&0xF]<<4);
	X&=0x0FFFFFFF; Y&=0x0FFFFFFF;
	for (i=0;i<16;i++){
		if(i<2||i==8||i==15){X=((X<<1)|(X>>27))&0x0FFFFFFF;Y=((Y<<1)|(Y>>27))&0x0FFFFFFF;}
		else{X=((X<<2)|(X>>26))&0x0FFFFFFF;Y=((Y<<2)|(Y>>26))&0x0FFFFFFF;}
		*SK++=((X<<4)&0x24000000)|((X<<28)&0x10000000)|((X<<14)&0x08000000)|((X<<18)&0x02080000)
			|((X<<6)&0x01000000)|((X<<9)&0x00200000)|((X>>1)&0x00100000)|((X<<10)&0x00040000)
			|((X<<2)&0x00020000)|((X>>10)&0x00010000)|((Y>>13)&0x00002000)|((Y>>4)&0x00001000)
			|((Y<<6)&0x00000800)|((Y>>1)&0x00000400)|((Y>>14)&0x00000200)|((Y)&0x00000100)
			|((Y>>5)&0x00000020)|((Y>>10)&0x00000010)|((Y>>3)&0x00000008)|((Y>>18)&0x00000004)
			|((Y>>26)&0x00000002)|((Y>>24)&0x00000001);
		*SK++=((X<<15)&0x20000000)|((X<<17)&0x10000000)|((X<<10)&0x08000000)|((X<<22)&0x04000000)
			|((X>>2)&0x02000000)|((X<<1)&0x01000000)|((X<<16)&0x00200000)|((X<<11)&0x00100000)
			|((X<<3)&0x00080000)|((X>>6)&0x00040000)|((X<<15)&0x00020000)|((X>>4)&0x00010000)
			|((Y>>2)&0x00002000)|((Y<<8)&0x00001000)|((Y>>14)&0x00000808)|((Y>>9)&0x00000400)
			|((Y)&0x00000200)|((Y<<7)&0x00000100)|((Y>>7)&0x00000020)|((Y>>3)&0x00000011)
			|((Y<<2)&0x00000004)|((Y>>21)&0x00000002);
	}
}
static void des_crypt(const uint32_t SK[32], const uint8_t input[8], uint8_t output[8]) {
	uint32_t X,Y,T;
	DES_GET_UINT32(X,input,0); DES_GET_UINT32(Y,input,4);
	DES_IP(X,Y);
	DES_ROUND(Y,X);DES_ROUND(X,Y);DES_ROUND(Y,X);DES_ROUND(X,Y);
	DES_ROUND(Y,X);DES_ROUND(X,Y);DES_ROUND(Y,X);DES_ROUND(X,Y);
	DES_ROUND(Y,X);DES_ROUND(X,Y);DES_ROUND(Y,X);DES_ROUND(X,Y);
	DES_ROUND(Y,X);DES_ROUND(X,Y);DES_ROUND(Y,X);DES_ROUND(X,Y);
	DES_FP(Y,X);
	DES_PUT_UINT32(Y,output,0); DES_PUT_UINT32(X,output,4);
}

/* DES padding (ISO7816-4 and PKCS7) */
#define PADDING_MODE_ISO7816_4 0
#define PADDING_MODE_PKCS7 1
#define PADDING_MODE_COUNT 2
typedef void (*padding_add_fn)(uint8_t buf[8], int offset);
typedef int (*padding_remove_fn)(const uint8_t *last);

static void pad_add_iso(uint8_t buf[8], int off) { buf[off]=0x80; memset(buf+off+1,0,7-off); }
static int pad_rm_iso(const uint8_t *last) {
	int p=1; int i;
	for (i=0;i<8;i++,last--){if(*last==0){p++;}else if(*last==0x80){return p;}else break;}
	return 0;
}
static void pad_add_pkcs7(uint8_t buf[8], int off) { uint8_t x=8-off; memset(buf+off,x,8-off); }
static int pad_rm_pkcs7(const uint8_t *last) {
	int p=*last; int i;
	for (i=1;i<p;i++){--last;if(*last!=p)return 0;}
	return p;
}
static padding_add_fn des_pad_add[2] = { pad_add_iso, pad_add_pkcs7 };
static padding_remove_fn des_pad_rm[2] = { pad_rm_iso, pad_rm_pkcs7 };

static int crypt_des_encode(const uint8_t key[8], const uint8_t *text, size_t textsz, int mode, uint8_t *out) {
	uint32_t SK[32]; des_main_ks(SK,key);
	size_t chunksz=(textsz+8)&~(size_t)7; size_t i;
	for (i=0;i+7<textsz;i+=8) des_crypt(SK,text+i,out+i);
	uint8_t tail[8]; int off=(int)(textsz-i);
	memcpy(tail,text+i,off);
	des_pad_add[mode](tail,off);
	des_crypt(SK,tail,out+i);
	return (int)chunksz;
}
static int crypt_des_decode(const uint8_t key[8], const uint8_t *text, size_t textsz, int mode, uint8_t *out) {
	uint32_t ESK[32]; des_main_ks(ESK,key);
	uint32_t SK[32]; int i;
	for (i=0;i<32;i+=2){SK[i]=ESK[30-i];SK[i+1]=ESK[31-i];}
	for (i=0;i<(int)textsz;i+=8) des_crypt(SK,text+i,out+i);
	int p=des_pad_rm[mode](out+textsz-1);
	if (p<=0||p>8) return -1;
	return (int)textsz-p;
}

/* ================================================================
 * Hashkey  (DJB+JS dual hash, ported from lua-crypt.c)
 * ================================================================ */
static void crypt_hash(const char *str, int sz, uint8_t key[8]) {
	uint32_t djb=5381L, js=1315423911L; int i;
	for (i=0;i<sz;i++){uint8_t c=(uint8_t)str[i];djb+=(djb<<5)+c;js^=((js<<5)+c+(js>>2));}
	key[0]=djb&0xff;key[1]=(djb>>8)&0xff;key[2]=(djb>>16)&0xff;key[3]=(djb>>24)&0xff;
	key[4]=js&0xff;key[5]=(js>>8)&0xff;key[6]=(js>>16)&0xff;key[7]=(js>>24)&0xff;
}

/* ================================================================
 * DH key exchange  (ported from lua-crypt.c)
 * ================================================================ */
#define DH_P 0xffffffffffffffc5ULL
#define DH_G 5

static inline uint64_t mul_mod_p(uint64_t a, uint64_t b) {
	uint64_t m=0;
	while(b){
		if(b&1){uint64_t t=DH_P-a;if(m>=t)m-=t;else m+=a;}
		if(a>=DH_P-a)a=a*2-DH_P;else a=a*2;
		b>>=1;
	}
	return m;
}
static inline uint64_t pow_mod_p(uint64_t a, uint64_t b) {
	if(b==1)return a;
	uint64_t t=pow_mod_p(a,b>>1);
	t=mul_mod_p(t,t);
	if(b%2)t=mul_mod_p(t,a);
	return t;
}
static uint64_t powmodp(uint64_t a, uint64_t b) {
	if(a>DH_P)a%=DH_P;
	return pow_mod_p(a,b);
}
static void write_u64_le_64(uint64_t v, uint8_t out[8]) {
	out[0]=v&0xff;out[1]=(v>>8)&0xff;out[2]=(v>>16)&0xff;out[3]=(v>>24)&0xff;
	out[4]=(v>>32)&0xff;out[5]=(v>>40)&0xff;out[6]=(v>>48)&0xff;out[7]=(v>>56)&0xff;
}

/* ================================================================
 * Base64  (ported from lua-crypt.c, RFC 4648)
 * ================================================================ */
static const char *b64_enc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int crypt_b64_encode(const uint8_t *text, size_t sz, char *out) {
	int i,j=0;
	for (i=0;i<(int)sz-2;i+=3){
		uint32_t v=(uint32_t)text[i]<<16|text[i+1]<<8|text[i+2];
		out[j]=b64_enc[v>>18];out[j+1]=b64_enc[(v>>12)&0x3f];
		out[j+2]=b64_enc[(v>>6)&0x3f];out[j+3]=b64_enc[v&0x3f];j+=4;
	}
	int pad=(int)sz-i;
	if(pad==1){uint32_t v=text[i];out[j]=b64_enc[v>>2];out[j+1]=b64_enc[(v&3)<<4];out[j+2]='=';out[j+3]='=';j+=4;}
	else if(pad==2){uint32_t v=(uint32_t)text[i]<<8|text[i+1];out[j]=b64_enc[v>>10];out[j+1]=b64_enc[(v>>4)&0x3f];out[j+2]=b64_enc[(v&0xf)<<2];out[j+3]='=';j+=4;}
	return j;
}
static inline int b64index(uint8_t c) {
	static const int dec[]={62,-1,-1,-1,63,52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-2,-1,-1,-1,
		0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,
		-1,-1,-1,-1,-1,-1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51};
	int dsz=(int)(sizeof(dec)/sizeof(dec[0]));
	if(c<43)return -1; c-=43; if(c>=dsz)return -1; return dec[c];
}
static int crypt_b64_decode(const uint8_t *text, size_t sz, uint8_t *out) {
	int i,j,output=0;
	for (i=0;i<(int)sz;){
		int padding=0,c[4];
		for(j=0;j<4;){
			if(i>=(int)sz&&4>j){c[j]=-2;}else{c[j]=b64index(text[i]);}
			if(c[j]==-1){++i;continue;}
			if(c[j]==-2)++padding;
			++i;++j;
		}
		uint32_t v;
		switch(padding){
		case 0:v=(unsigned)c[0]<<18|c[1]<<12|c[2]<<6|c[3];
			out[output]=v>>16;out[output+1]=(v>>8)&0xff;out[output+2]=v&0xff;output+=3;break;
		case 1:v=(unsigned)c[0]<<10|c[1]<<4|c[2]>>2;
			out[output]=v>>8;out[output+1]=v&0xff;output+=2;break;
		case 2:v=(unsigned)c[0]<<2|c[1]>>4;
			out[output]=v;output+=1;break;
		default:return -1;
		}
	}
	return output;
}

/* ================================================================
 * Hex encode/decode  (ported from lua-crypt.c)
 * ================================================================ */
static void crypt_hex_encode(const uint8_t *text, size_t sz, char *out) {
	static const char hex[]="0123456789abcdef"; size_t i;
	for (i=0;i<sz;i++){out[i*2]=hex[text[i]>>4];out[i*2+1]=hex[text[i]&0xf];}
}
#define HEXVAL(v,c) {char _t=(char)(c);if(_t>='0'&&_t<='9'){v=_t-'0';}else{v=_t-'a'+10;}}
static int crypt_hex_decode(const char *text, size_t sz, uint8_t *out) {
	if(sz&1)return -1; size_t i;
	for(i=0;i<sz;i+=2){uint8_t hi,lo;HEXVAL(hi,text[i]);HEXVAL(lo,text[i+1]);
		if(hi>16||lo>16)return -1;out[i/2]=hi<<4|lo;}
	return (int)(sz/2);
}

/* ================================================================
 * XOR / Random  (ported from lua-crypt.c)
 * ================================================================ */
static void crypt_xor_inplace(uint8_t *data, size_t dlen, const uint8_t *key, size_t klen) {
	size_t i; for (i=0;i<dlen;i++) data[i]^=key[i%klen];
}
static void crypt_random_bytes(uint8_t *out, size_t n) {
#if defined(__linux__)
	getrandom(out,n,0);
#elif defined(_WIN32)
	/* mingw has neither getrandom nor arc4random_buf; rand_s wraps RtlGenRandom */
	size_t i;
	for (i = 0; i < n; ) {
		unsigned int r = 0;
		size_t chunk = (n - i < sizeof(r)) ? (n - i) : sizeof(r);
		rand_s(&r);
		memcpy(out + i, &r, chunk);
		i += chunk;
	}
#else
	arc4random_buf(out,n);
#endif
}


/* ================================================================
 * JS bridge functions  (ArrayBuffer I/O, registered on skynetcore.crypt)
 * ================================================================ */

static JSValue js_crypt_sha1(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; uint8_t *p=JS_GetArrayBuffer(ctx,&sz,argv[0]); if(!p) return JS_EXCEPTION;
	SHA1_CTX c; sha1_init(&c); sha1_update(&c,p,sz);
	uint8_t d[SHA1_DIGEST_SIZE]; sha1_final(&c,d);
	return JS_NewArrayBufferCopy(ctx,d,SHA1_DIGEST_SIZE);
}
static JSValue js_crypt_sha256(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; uint8_t *p=JS_GetArrayBuffer(ctx,&sz,argv[0]); if(!p) return JS_EXCEPTION;
	SHA256_CTX c; sha256_init(&c); sha256_update(&c,p,sz);
	uint8_t d[32]; sha256_final(&c,d);
	return JS_NewArrayBufferCopy(ctx,d,32);
}
static JSValue js_crypt_sha512(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; uint8_t *p=JS_GetArrayBuffer(ctx,&sz,argv[0]); if(!p) return JS_EXCEPTION;
	SHA512_CTX c; sha512_init(&c); sha512_update(&c,p,sz);
	uint8_t d[64]; sha512_final(&c,d);
	return JS_NewArrayBufferCopy(ctx,d,64);
}
static JSValue js_crypt_hmac_sha1(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t ksz,dsz;
	uint8_t *key=JS_GetArrayBuffer(ctx,&ksz,argv[0]); if(!key) return JS_EXCEPTION;
	uint8_t *data=JS_GetArrayBuffer(ctx,&dsz,argv[1]); if(!data) return JS_EXCEPTION;
	uint8_t out[SHA1_DIGEST_SIZE]; hmac_sha1(key,ksz,data,dsz,out);
	return JS_NewArrayBufferCopy(ctx,out,SHA1_DIGEST_SIZE);
}
static JSValue js_crypt_hmac_sha256(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t ksz,dsz;
	uint8_t *key=JS_GetArrayBuffer(ctx,&ksz,argv[0]); if(!key) return JS_EXCEPTION;
	uint8_t *data=JS_GetArrayBuffer(ctx,&dsz,argv[1]); if(!data) return JS_EXCEPTION;
	uint8_t out[32]; hmac_sha256(key,ksz,data,dsz,out);
	return JS_NewArrayBufferCopy(ctx,out,32);
}
static JSValue js_crypt_hmac_sha512(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t ksz,dsz;
	uint8_t *key=JS_GetArrayBuffer(ctx,&ksz,argv[0]); if(!key) return JS_EXCEPTION;
	uint8_t *data=JS_GetArrayBuffer(ctx,&dsz,argv[1]); if(!data) return JS_EXCEPTION;
	uint8_t out[64]; hmac_sha512(key,ksz,data,dsz,out);
	return JS_NewArrayBufferCopy(ctx,out,64);
}
static JSValue js_crypt_base64_encode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; uint8_t *p=JS_GetArrayBuffer(ctx,&sz,argv[0]); if(!p) return JS_EXCEPTION;
	int enc_sz=((int)sz+2)/3*4;
	char tmp[SMALL_CHUNK]; char *buf=tmp;
	if(enc_sz>SMALL_CHUNK) buf=skynet_malloc(enc_sz);
	int out=crypt_b64_encode(p,sz,buf);
	JSValue ret=JS_NewStringLen(ctx,buf,out);
	if(buf!=tmp) skynet_free(buf);
	return ret;
}
static JSValue js_crypt_base64_decode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; const char *s=JS_ToCStringLen(ctx,&sz,argv[0]); if(!s) return JS_EXCEPTION;
	int dec_sz=((int)sz+3)/4*3;
	uint8_t tmp[SMALL_CHUNK]; uint8_t *buf=tmp;
	if(dec_sz>SMALL_CHUNK) buf=skynet_malloc(dec_sz);
	int out=crypt_b64_decode((const uint8_t*)s,sz,buf);
	JS_FreeCString(ctx,s);
	if(out<0){if(buf!=tmp)skynet_free(buf);return JS_ThrowTypeError(ctx,"Invalid base64 text");}
	JSValue ret=JS_NewArrayBufferCopy(ctx,buf,out);
	if(buf!=tmp) skynet_free(buf);
	return ret;
}
static JSValue js_crypt_hex_encode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; uint8_t *p=JS_GetArrayBuffer(ctx,&sz,argv[0]); if(!p) return JS_EXCEPTION;
	char tmp[SMALL_CHUNK]; char *buf=tmp;
	if(sz*2>SMALL_CHUNK) buf=skynet_malloc(sz*2);
	crypt_hex_encode(p,sz,buf);
	JSValue ret=JS_NewStringLen(ctx,buf,sz*2);
	if(buf!=tmp) skynet_free(buf);
	return ret;
}
static JSValue js_crypt_hex_decode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; const char *s=JS_ToCStringLen(ctx,&sz,argv[0]); if(!s) return JS_EXCEPTION;
	uint8_t tmp[SMALL_CHUNK]; uint8_t *buf=tmp;
	if(sz/2>SMALL_CHUNK) buf=skynet_malloc(sz/2);
	int out=crypt_hex_decode(s,sz,buf);
	JS_FreeCString(ctx,s);
	if(out<0){if(buf!=tmp)skynet_free(buf);return JS_ThrowTypeError(ctx,"Invalid hex text");}
	JSValue ret=JS_NewArrayBufferCopy(ctx,buf,out);
	if(buf!=tmp) skynet_free(buf);
	return ret;
}
static JSValue js_crypt_xor_str(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t dsz,ksz;
	uint8_t *data=JS_GetArrayBuffer(ctx,&dsz,argv[0]); if(!data) return JS_EXCEPTION;
	uint8_t *key=JS_GetArrayBuffer(ctx,&ksz,argv[1]); if(!key) return JS_EXCEPTION;
	if(ksz==0) return JS_ThrowTypeError(ctx,"xor key can't be empty");
	crypt_xor_inplace(data,dsz,key,ksz);
	return JS_DupValue(ctx,argv[0]);
}
static JSValue js_crypt_random_bytes(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	int32_t n; if(JS_ToInt32(ctx,&n,argv[0])) return JS_EXCEPTION;
	if(n<=0) return JS_ThrowRangeError(ctx,"random_bytes: n must be positive");
	uint8_t tmp[SMALL_CHUNK]; uint8_t *buf=tmp;
	if(n>SMALL_CHUNK) buf=skynet_malloc(n);
	crypt_random_bytes(buf,n);
	JSValue ret=JS_NewArrayBufferCopy(ctx,buf,n);
	if(buf!=tmp) skynet_free(buf);
	return ret;
}
static JSValue js_crypt_randomkey(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;(void)argv;
	uint8_t tmp[8]; char x=0; int i;
	crypt_random_bytes(tmp, 8);
	for(i=0;i<8;i++){x^=tmp[i];}
	if(x==0) tmp[0]|=1;
	return JS_NewArrayBufferCopy(ctx,tmp,8);
}
static JSValue js_crypt_hashkey(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; uint8_t *p=JS_GetArrayBuffer(ctx,&sz,argv[0]); if(!p) return JS_EXCEPTION;
	uint8_t out[8]; crypt_hash((const char*)p,(int)sz,out);
	return JS_NewArrayBufferCopy(ctx,out,8);
}
static JSValue js_crypt_des_encode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	size_t ksz,tsz;
	uint8_t *key=JS_GetArrayBuffer(ctx,&ksz,argv[0]); if(!key||ksz!=8) return JS_ThrowTypeError(ctx,"des key must be 8 bytes");
	uint8_t *text=JS_GetArrayBuffer(ctx,&tsz,argv[1]); if(!text) return JS_EXCEPTION;
	int32_t mode=PADDING_MODE_ISO7816_4;
	if(argc>2&&!JS_IsUndefined(argv[2])) JS_ToInt32(ctx,&mode,argv[2]);
	if(mode<0||mode>=PADDING_MODE_COUNT) return JS_ThrowRangeError(ctx,"Invalid padding mode");
	size_t chunksz=(tsz+8)&~(size_t)7;
	uint8_t tmp[SMALL_CHUNK]; uint8_t *buf=tmp;
	if(chunksz>SMALL_CHUNK) buf=skynet_malloc(chunksz);
	int out=crypt_des_encode(key,text,tsz,mode,buf);
	JSValue ret=JS_NewArrayBufferCopy(ctx,buf,out);
	if(buf!=tmp) skynet_free(buf);
	return ret;
}
static JSValue js_crypt_des_decode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	size_t ksz,tsz;
	uint8_t *key=JS_GetArrayBuffer(ctx,&ksz,argv[0]); if(!key||ksz!=8) return JS_ThrowTypeError(ctx,"des key must be 8 bytes");
	uint8_t *text=JS_GetArrayBuffer(ctx,&tsz,argv[1]); if(!text) return JS_EXCEPTION;
	if((tsz&7)||tsz==0) return JS_ThrowTypeError(ctx,"Invalid des ciphertext length");
	int32_t mode=PADDING_MODE_ISO7816_4;
	if(argc>2&&!JS_IsUndefined(argv[2])) JS_ToInt32(ctx,&mode,argv[2]);
	if(mode<0||mode>=PADDING_MODE_COUNT) return JS_ThrowRangeError(ctx,"Invalid padding mode");
	uint8_t tmp[SMALL_CHUNK]; uint8_t *buf=tmp;
	if(tsz>SMALL_CHUNK) buf=skynet_malloc(tsz);
	int out=crypt_des_decode(key,text,tsz,mode,buf);
	if(out<0){if(buf!=tmp)skynet_free(buf);return JS_ThrowTypeError(ctx,"Invalid des ciphertext");}
	JSValue ret=JS_NewArrayBufferCopy(ctx,buf,out);
	if(buf!=tmp) skynet_free(buf);
	return ret;
}
static JSValue js_crypt_hmac64(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t xs,ys;
	uint8_t *xp=JS_GetArrayBuffer(ctx,&xs,argv[0]); if(!xp||xs!=8) return JS_ThrowTypeError(ctx,"hmac64: args must be 8 bytes");
	uint8_t *yp=JS_GetArrayBuffer(ctx,&ys,argv[1]); if(!yp||ys!=8) return JS_ThrowTypeError(ctx,"hmac64: args must be 8 bytes");
	uint32_t x[2],y[2],r[2]; read_u64_le(xp,x); read_u64_le(yp,y);
	crypt_hmac64(x,y,r);
	uint8_t out[8]; write_u64_le(r,out);
	return JS_NewArrayBufferCopy(ctx,out,8);
}
static JSValue js_crypt_hmac64_md5(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t xs,ys;
	uint8_t *xp=JS_GetArrayBuffer(ctx,&xs,argv[0]); if(!xp||xs!=8) return JS_ThrowTypeError(ctx,"hmac64_md5: args must be 8 bytes");
	uint8_t *yp=JS_GetArrayBuffer(ctx,&ys,argv[1]); if(!yp||ys!=8) return JS_ThrowTypeError(ctx,"hmac64_md5: args must be 8 bytes");
	uint32_t x[2],y[2],r[2]; read_u64_le(xp,x); read_u64_le(yp,y);
	crypt_hmac64_md5(x,y,r);
	uint8_t out[8]; write_u64_le(r,out);
	return JS_NewArrayBufferCopy(ctx,out,8);
}
static JSValue js_crypt_hmac_hash(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t ksz,tsz;
	uint8_t *kp=JS_GetArrayBuffer(ctx,&ksz,argv[0]); if(!kp||ksz!=8) return JS_ThrowTypeError(ctx,"hmac_hash: key must be 8 bytes");
	uint8_t *tp=JS_GetArrayBuffer(ctx,&tsz,argv[1]); if(!tp) return JS_EXCEPTION;
	uint32_t key[2]; read_u64_le(kp,key);
	uint8_t h[8]; crypt_hash((const char*)tp,(int)tsz,h);
	uint32_t htext[2]; read_u64_le(h,htext);
	uint32_t result[2]; crypt_hmac64(htext,key,result);
	uint8_t out[8]; write_u64_le(result,out);
	return JS_NewArrayBufferCopy(ctx,out,8);
}
static JSValue js_crypt_dh_exchange(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t sz; uint8_t *p=JS_GetArrayBuffer(ctx,&sz,argv[0]);
	if(!p||sz!=8) return JS_ThrowTypeError(ctx,"dh_exchange: key must be 8 bytes");
	uint32_t xx[2]; read_u64_le(p,xx);
	uint64_t x64=(uint64_t)xx[0]|(uint64_t)xx[1]<<32;
	if(x64==0) return JS_ThrowTypeError(ctx,"dh key can't be 0");
	uint64_t r=powmodp(DH_G,x64);
	uint8_t out[8]; write_u64_le_64(r,out);
	return JS_NewArrayBufferCopy(ctx,out,8);
}
static JSValue js_crypt_dh_secret(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;(void)argc;
	size_t xs,ys;
	uint8_t *xp=JS_GetArrayBuffer(ctx,&xs,argv[0]); if(!xp||xs!=8) return JS_ThrowTypeError(ctx,"dh_secret: args must be 8 bytes");
	uint8_t *yp=JS_GetArrayBuffer(ctx,&ys,argv[1]); if(!yp||ys!=8) return JS_ThrowTypeError(ctx,"dh_secret: args must be 8 bytes");
	uint32_t x[2],y[2]; read_u64_le(xp,x); read_u64_le(yp,y);
	uint64_t xx=(uint64_t)x[0]|(uint64_t)x[1]<<32;
	uint64_t yy=(uint64_t)y[0]|(uint64_t)y[1]<<32;
	if(xx==0||yy==0) return JS_ThrowTypeError(ctx,"dh args can't be 0");
	uint64_t r=powmodp(xx,yy);
	uint8_t out[8]; write_u64_le_64(r,out);
	return JS_NewArrayBufferCopy(ctx,out,8);
}

/* ================================================================
 * zlib compression (deflate/inflate + gzip)
 * ================================================================ */
#include <zlib.h>

/* one-shot helper: which = 0 deflate (zlib), 1 inflate, 2 gzip deflate,
 * 3 gzip inflate */
static JSValue
js_crypt_zlib(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv, int which) {
	(void)tv; (void)argc;
	size_t in_len = 0;
	uint8_t *in = JS_GetArrayBuffer(ctx, &in_len, argv[0]);
	if (!in) return JS_EXCEPTION;

	z_stream strm;
	memset(&strm, 0, sizeof(strm));
	int window = (which == 2 || which == 3) ? 15 + 16 : 15;
	int rc = (which == 0 || which == 2) ?
		deflateInit2(&strm, Z_DEFAULT_COMPRESSION, Z_DEFLATED, window, 8,
			Z_DEFAULT_STRATEGY) :
		inflateInit2(&strm, window);
	if (rc != Z_OK) return JS_ThrowInternalError(ctx, "zlib init failed: %d", rc);

	size_t cap = in_len > 0 ? in_len : 1;
	size_t out_cap = which == 0 || which == 2 ? cap + cap / 2 + 64 : cap * 4 + 64;
	uint8_t *out = skynet_malloc(out_cap);
	if (!out) {
		if (which == 0 || which == 2) deflateEnd(&strm); else inflateEnd(&strm);
		return JS_EXCEPTION;
	}
	strm.next_in = in;
	strm.avail_in = (uInt)in_len;
	strm.next_out = out;
	strm.avail_out = (uInt)out_cap;

	for (;;) {
		rc = (which == 0 || which == 2) ?
			deflate(&strm, Z_FINISH) : inflate(&strm, Z_NO_FLUSH);
		if (rc == Z_STREAM_END) break;
		if (rc != Z_OK && rc != Z_BUF_ERROR) {
			int bad = rc;
			(which == 0 || which == 2) ? deflateEnd(&strm) : inflateEnd(&strm);
			skynet_free(out);
			return JS_ThrowInternalError(ctx, "zlib failed: %d", bad);
		}
		if (strm.avail_out == 0) {
			size_t used = out_cap;
			out_cap *= 2;
			uint8_t *grown = skynet_malloc(out_cap);
			memcpy(grown, out, used);
			skynet_free(out);
			out = grown;
			strm.next_out = out + used;
			strm.avail_out = (uInt)(out_cap - used);
		} else if (which == 1 || which == 3) {
			/* input exhausted without a stream end: truncated / incomplete */
			break;
		} else {
			break;
		}
	}
	size_t produced = out_cap - strm.avail_out;
	(which == 0 || which == 2) ? deflateEnd(&strm) : inflateEnd(&strm);
	JSValue ret = JS_NewArrayBufferCopy(ctx, out, produced);
	skynet_free(out);
	return ret;
}

static JSValue js_crypt_deflate(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	return js_crypt_zlib(ctx, tv, argc, argv, 0);
}
static JSValue js_crypt_inflate(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	return js_crypt_zlib(ctx, tv, argc, argv, 1);
}
static JSValue js_crypt_gzip(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	return js_crypt_zlib(ctx, tv, argc, argv, 2);
}
static JSValue js_crypt_gunzip(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	return js_crypt_zlib(ctx, tv, argc, argv, 3);
}

/* ================================================================
 * Registration
 * ================================================================ */
#ifdef USE_OPENSSL
static void register_openssl_crypto(JSContext *ctx, JSValue crypt);
#endif

void register_crypto_bridge(JSContext *ctx, JSValue global) {
	static ATOM_INT seed_init = 0;
	if (ATOM_CAS(&seed_init, 0, 1)) {
		srandom((random() << 8) ^ (time(NULL) << 16) ^ getpid());
	}
	JSValue skynetcore = JS_GetPropertyStr(ctx, global, "skynetcore");
	JSValue crypt = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx,crypt,"sha1",JS_NewCFunction(ctx,js_crypt_sha1,"sha1",1));
	JS_SetPropertyStr(ctx,crypt,"sha256",JS_NewCFunction(ctx,js_crypt_sha256,"sha256",1));
	JS_SetPropertyStr(ctx,crypt,"sha512",JS_NewCFunction(ctx,js_crypt_sha512,"sha512",1));
	JS_SetPropertyStr(ctx,crypt,"hmacSha1",JS_NewCFunction(ctx,js_crypt_hmac_sha1,"hmacSha1",2));
	JS_SetPropertyStr(ctx,crypt,"hmacSha256",JS_NewCFunction(ctx,js_crypt_hmac_sha256,"hmacSha256",2));
	JS_SetPropertyStr(ctx,crypt,"hmacSha512",JS_NewCFunction(ctx,js_crypt_hmac_sha512,"hmacSha512",2));
	JS_SetPropertyStr(ctx,crypt,"base64Encode",JS_NewCFunction(ctx,js_crypt_base64_encode,"base64Encode",1));
	JS_SetPropertyStr(ctx,crypt,"base64Decode",JS_NewCFunction(ctx,js_crypt_base64_decode,"base64Decode",1));
	JS_SetPropertyStr(ctx,crypt,"hexEncode",JS_NewCFunction(ctx,js_crypt_hex_encode,"hexEncode",1));
	JS_SetPropertyStr(ctx,crypt,"hexDecode",JS_NewCFunction(ctx,js_crypt_hex_decode,"hexDecode",1));
	JS_SetPropertyStr(ctx,crypt,"xorStr",JS_NewCFunction(ctx,js_crypt_xor_str,"xorStr",2));
	JS_SetPropertyStr(ctx,crypt,"randomBytes",JS_NewCFunction(ctx,js_crypt_random_bytes,"randomBytes",1));
	JS_SetPropertyStr(ctx,crypt,"randomkey",JS_NewCFunction(ctx,js_crypt_randomkey,"randomkey",0));
	JS_SetPropertyStr(ctx,crypt,"hashkey",JS_NewCFunction(ctx,js_crypt_hashkey,"hashkey",1));
	JS_SetPropertyStr(ctx,crypt,"desEncode",JS_NewCFunction(ctx,js_crypt_des_encode,"desEncode",3));
	JS_SetPropertyStr(ctx,crypt,"desDecode",JS_NewCFunction(ctx,js_crypt_des_decode,"desDecode",3));
	JS_SetPropertyStr(ctx,crypt,"hmac64",JS_NewCFunction(ctx,js_crypt_hmac64,"hmac64",2));
	JS_SetPropertyStr(ctx,crypt,"hmac64Md5",JS_NewCFunction(ctx,js_crypt_hmac64_md5,"hmac64Md5",2));
	JS_SetPropertyStr(ctx,crypt,"hmacHash",JS_NewCFunction(ctx,js_crypt_hmac_hash,"hmacHash",2));
	JS_SetPropertyStr(ctx,crypt,"dhExchange",JS_NewCFunction(ctx,js_crypt_dh_exchange,"dhExchange",1));
	JS_SetPropertyStr(ctx,crypt,"dhSecret",JS_NewCFunction(ctx,js_crypt_dh_secret,"dhSecret",2));
#ifdef USE_OPENSSL
	register_openssl_crypto(ctx, crypt);
#endif
	JS_SetPropertyStr(ctx,crypt,"deflate",JS_NewCFunction(ctx,js_crypt_deflate,"deflate",1));
	JS_SetPropertyStr(ctx,crypt,"inflate",JS_NewCFunction(ctx,js_crypt_inflate,"inflate",1));
	JS_SetPropertyStr(ctx,crypt,"gzip",JS_NewCFunction(ctx,js_crypt_gzip,"gzip",1));
	JS_SetPropertyStr(ctx,crypt,"gunzip",JS_NewCFunction(ctx,js_crypt_gunzip,"gunzip",1));
	JS_SetPropertyStr(ctx, skynetcore, "crypt", crypt);
	JS_FreeValue(ctx, skynetcore);
}

/* ================================================================
 * Phase 7: OpenSSL-backed algorithms (AES-GCM, Ed25519, X25519)
 * Compiled only when USE_OPENSSL is defined (make TLS=openssl).
 * ================================================================ */
#ifdef USE_OPENSSL
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/err.h>

/* ---- AES-GCM encrypt ----
 * aes_gcm_encrypt(key: AB(16|32), plaintext: AB, iv?: AB(12), aad?: AB)
 *   → { ciphertext: AB, tag: AB(16), iv: AB(12) }
 */
static JSValue js_crypt_aes_gcm_encrypt(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	size_t key_sz, pt_sz;
	uint8_t *key = JS_GetArrayBuffer(ctx, &key_sz, argv[0]);
	if (!key) return JS_EXCEPTION;
	if (key_sz != 16 && key_sz != 32)
		return JS_ThrowTypeError(ctx, "aes_gcm_encrypt: key must be 16 or 32 bytes");
	uint8_t *pt = JS_GetArrayBuffer(ctx, &pt_sz, argv[1]);
	if (!pt) return JS_EXCEPTION;

	uint8_t iv_buf[12];
	uint8_t *iv = iv_buf;
	int iv_generated = 0;
	if (argc > 2 && JS_IsArrayBuffer(argv[2])) {
		size_t iv_sz;
		iv = JS_GetArrayBuffer(ctx, &iv_sz, argv[2]);
		if (!iv || iv_sz != 12)
			return JS_ThrowTypeError(ctx, "aes_gcm_encrypt: iv must be 12 bytes");
	} else {
		RAND_bytes(iv_buf, 12);
		iv = iv_buf;
		iv_generated = 1;
	}

	uint8_t *aad = NULL; size_t aad_sz = 0;
	if (argc > 3 && JS_IsArrayBuffer(argv[3])) {
		aad = JS_GetArrayBuffer(ctx, &aad_sz, argv[3]);
		if (!aad) return JS_EXCEPTION;
	}

	const EVP_CIPHER *cipher = (key_sz == 16) ? EVP_aes_128_gcm() : EVP_aes_256_gcm();
	EVP_CIPHER_CTX *ectx = EVP_CIPHER_CTX_new();
	if (!ectx) return JS_ThrowInternalError(ctx, "EVP_CIPHER_CTX_new failed");

	int ok = 0;
	uint8_t *ct = skynet_malloc(pt_sz > 0 ? pt_sz : 1);
	uint8_t tag[16];
	int outlen = 0, tmplen = 0;

	if (EVP_EncryptInit_ex(ectx, cipher, NULL, NULL, NULL) != 1) goto enc_fail;
	if (EVP_CIPHER_CTX_ctrl(ectx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL) != 1) goto enc_fail;
	if (EVP_EncryptInit_ex(ectx, NULL, NULL, key, iv) != 1) goto enc_fail;
	if (aad && aad_sz > 0) {
		if (EVP_EncryptUpdate(ectx, NULL, &tmplen, aad, (int)aad_sz) != 1) goto enc_fail;
	}
	if (pt_sz > 0) {
		if (EVP_EncryptUpdate(ectx, ct, &outlen, pt, (int)pt_sz) != 1) goto enc_fail;
	}
	if (EVP_EncryptFinal_ex(ectx, ct + outlen, &tmplen) != 1) goto enc_fail;
	outlen += tmplen;
	if (EVP_CIPHER_CTX_ctrl(ectx, EVP_CTRL_GCM_GET_TAG, 16, tag) != 1) goto enc_fail;
	ok = 1;

enc_fail:
	EVP_CIPHER_CTX_free(ectx);
	if (!ok) { skynet_free(ct); return JS_ThrowInternalError(ctx, "AES-GCM encrypt failed"); }

	JSValue result = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, result, "ciphertext", JS_NewArrayBufferCopy(ctx, ct, outlen));
	JS_SetPropertyStr(ctx, result, "tag", JS_NewArrayBufferCopy(ctx, tag, 16));
	if (iv_generated)
		JS_SetPropertyStr(ctx, result, "iv", JS_NewArrayBufferCopy(ctx, iv_buf, 12));
	else
		JS_SetPropertyStr(ctx, result, "iv", JS_NewArrayBufferCopy(ctx, iv, 12));
	skynet_free(ct);
	return result;
}

/* ---- AES-GCM decrypt ----
 * aes_gcm_decrypt(key: AB, ciphertext: AB, iv: AB(12), tag: AB(16), aad?: AB)
 *   → AB (plaintext)
 */
static JSValue js_crypt_aes_gcm_decrypt(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	size_t key_sz, ct_sz, iv_sz, tag_sz;
	uint8_t *key = JS_GetArrayBuffer(ctx, &key_sz, argv[0]);
	if (!key) return JS_EXCEPTION;
	if (key_sz != 16 && key_sz != 32)
		return JS_ThrowTypeError(ctx, "aes_gcm_decrypt: key must be 16 or 32 bytes");
	uint8_t *ct = JS_GetArrayBuffer(ctx, &ct_sz, argv[1]);
	if (!ct) return JS_EXCEPTION;
	uint8_t *iv = JS_GetArrayBuffer(ctx, &iv_sz, argv[2]);
	if (!iv || iv_sz != 12)
		return JS_ThrowTypeError(ctx, "aes_gcm_decrypt: iv must be 12 bytes");
	uint8_t *tag = JS_GetArrayBuffer(ctx, &tag_sz, argv[3]);
	if (!tag || tag_sz != 16)
		return JS_ThrowTypeError(ctx, "aes_gcm_decrypt: tag must be 16 bytes");

	uint8_t *aad = NULL; size_t aad_sz = 0;
	if (argc > 4 && JS_IsArrayBuffer(argv[4])) {
		aad = JS_GetArrayBuffer(ctx, &aad_sz, argv[4]);
		if (!aad) return JS_EXCEPTION;
	}

	const EVP_CIPHER *cipher = (key_sz == 16) ? EVP_aes_128_gcm() : EVP_aes_256_gcm();
	EVP_CIPHER_CTX *dctx = EVP_CIPHER_CTX_new();
	if (!dctx) return JS_ThrowInternalError(ctx, "EVP_CIPHER_CTX_new failed");

	int ok = 0;
	uint8_t *pt = skynet_malloc(ct_sz > 0 ? ct_sz : 1);
	int outlen = 0, tmplen = 0;

	if (EVP_DecryptInit_ex(dctx, cipher, NULL, NULL, NULL) != 1) goto dec_fail;
	if (EVP_CIPHER_CTX_ctrl(dctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL) != 1) goto dec_fail;
	if (EVP_DecryptInit_ex(dctx, NULL, NULL, key, iv) != 1) goto dec_fail;
	if (aad && aad_sz > 0) {
		if (EVP_DecryptUpdate(dctx, NULL, &tmplen, aad, (int)aad_sz) != 1) goto dec_fail;
	}
	if (ct_sz > 0) {
		if (EVP_DecryptUpdate(dctx, pt, &outlen, ct, (int)ct_sz) != 1) goto dec_fail;
	}
	if (EVP_CIPHER_CTX_ctrl(dctx, EVP_CTRL_GCM_SET_TAG, 16, (void *)tag) != 1) goto dec_fail;
	if (EVP_DecryptFinal_ex(dctx, pt + outlen, &tmplen) != 1) {
		EVP_CIPHER_CTX_free(dctx);
		skynet_free(pt);
		return JS_ThrowTypeError(ctx, "AES-GCM decrypt: authentication tag mismatch");
	}
	outlen += tmplen;
	ok = 1;

dec_fail:
	EVP_CIPHER_CTX_free(dctx);
	if (!ok) { skynet_free(pt); return JS_ThrowInternalError(ctx, "AES-GCM decrypt failed"); }

	JSValue ret = JS_NewArrayBufferCopy(ctx, pt, outlen);
	skynet_free(pt);
	return ret;
}

/* ---- Ed25519 keypair ----
 * ed25519_keypair() → { public: AB(32), secret: AB(32) }
 * secret_key is the 32-byte seed (OpenSSL raw private key format).
 */
static JSValue js_crypt_ed25519_keypair(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	EVP_PKEY *pkey = NULL;
	EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, NULL);
	if (!pctx) return JS_ThrowInternalError(ctx, "ed25519: ctx_new failed");
	if (EVP_PKEY_keygen_init(pctx) != 1 || EVP_PKEY_keygen(pctx, &pkey) != 1) {
		EVP_PKEY_CTX_free(pctx);
		return JS_ThrowInternalError(ctx, "ed25519: keygen failed");
	}
	EVP_PKEY_CTX_free(pctx);

	uint8_t pub[32], sec[32];
	size_t pub_len = 32, sec_len = 32;
	EVP_PKEY_get_raw_public_key(pkey, pub, &pub_len);
	EVP_PKEY_get_raw_private_key(pkey, sec, &sec_len);
	EVP_PKEY_free(pkey);

	JSValue result = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, result, "publicKey", JS_NewArrayBufferCopy(ctx, pub, 32));
	JS_SetPropertyStr(ctx, result, "secretKey", JS_NewArrayBufferCopy(ctx, sec, 32));
	return result;
}

/* ---- Ed25519 sign ----
 * ed25519_sign(secret_key: AB(32), message: AB) → AB(64)
 */
static JSValue js_crypt_ed25519_sign(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	size_t sk_sz, msg_sz;
	uint8_t *sk = JS_GetArrayBuffer(ctx, &sk_sz, argv[0]);
	if (!sk || sk_sz != 32)
		return JS_ThrowTypeError(ctx, "ed25519_sign: secret_key must be 32 bytes");
	uint8_t *msg = JS_GetArrayBuffer(ctx, &msg_sz, argv[1]);
	if (!msg && msg_sz != 0) return JS_EXCEPTION;

	EVP_PKEY *pkey = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, sk, 32);
	if (!pkey) return JS_ThrowInternalError(ctx, "ed25519_sign: load key failed");

	EVP_MD_CTX *mdctx = EVP_MD_CTX_new();
	uint8_t sig[64];
	size_t sig_len = 64;
	int ok = 0;
	if (EVP_DigestSignInit(mdctx, NULL, NULL, NULL, pkey) == 1 &&
	    EVP_DigestSign(mdctx, sig, &sig_len, msg, msg_sz) == 1) {
		ok = 1;
	}
	EVP_MD_CTX_free(mdctx);
	EVP_PKEY_free(pkey);
	if (!ok) return JS_ThrowInternalError(ctx, "ed25519_sign failed");
	return JS_NewArrayBufferCopy(ctx, sig, sig_len);
}

/* ---- Ed25519 verify ----
 * ed25519_verify(public_key: AB(32), message: AB, signature: AB(64)) → boolean
 */
static JSValue js_crypt_ed25519_verify(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	size_t pk_sz, msg_sz, sig_sz;
	uint8_t *pk = JS_GetArrayBuffer(ctx, &pk_sz, argv[0]);
	if (!pk || pk_sz != 32)
		return JS_ThrowTypeError(ctx, "ed25519_verify: public_key must be 32 bytes");
	uint8_t *msg = JS_GetArrayBuffer(ctx, &msg_sz, argv[1]);
	if (!msg && msg_sz != 0) return JS_EXCEPTION;
	uint8_t *sig = JS_GetArrayBuffer(ctx, &sig_sz, argv[2]);
	if (!sig || sig_sz != 64)
		return JS_ThrowTypeError(ctx, "ed25519_verify: signature must be 64 bytes");

	EVP_PKEY *pkey = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, NULL, pk, 32);
	if (!pkey) return JS_NewBool(ctx, 0);

	EVP_MD_CTX *mdctx = EVP_MD_CTX_new();
	int valid = 0;
	if (EVP_DigestVerifyInit(mdctx, NULL, NULL, NULL, pkey) == 1 &&
	    EVP_DigestVerify(mdctx, sig, sig_sz, msg, msg_sz) == 1) {
		valid = 1;
	}
	EVP_MD_CTX_free(mdctx);
	EVP_PKEY_free(pkey);
	return JS_NewBool(ctx, valid);
}

/* ---- X25519 keypair ----
 * x25519_keypair() → { public: AB(32), secret: AB(32) }
 */
static JSValue js_crypt_x25519_keypair(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	EVP_PKEY *pkey = NULL;
	EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_X25519, NULL);
	if (!pctx) return JS_ThrowInternalError(ctx, "x25519: ctx_new failed");
	if (EVP_PKEY_keygen_init(pctx) != 1 || EVP_PKEY_keygen(pctx, &pkey) != 1) {
		EVP_PKEY_CTX_free(pctx);
		return JS_ThrowInternalError(ctx, "x25519: keygen failed");
	}
	EVP_PKEY_CTX_free(pctx);

	uint8_t pub[32], sec[32];
	size_t pub_len = 32, sec_len = 32;
	EVP_PKEY_get_raw_public_key(pkey, pub, &pub_len);
	EVP_PKEY_get_raw_private_key(pkey, sec, &sec_len);
	EVP_PKEY_free(pkey);

	JSValue result = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, result, "publicKey", JS_NewArrayBufferCopy(ctx, pub, 32));
	JS_SetPropertyStr(ctx, result, "secretKey", JS_NewArrayBufferCopy(ctx, sec, 32));
	return result;
}

/* ---- X25519 shared secret ----
 * x25519_shared(secret_key: AB(32), peer_public: AB(32)) → AB(32)
 */
static JSValue js_crypt_x25519_shared(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	size_t sk_sz, pk_sz;
	uint8_t *sk = JS_GetArrayBuffer(ctx, &sk_sz, argv[0]);
	if (!sk || sk_sz != 32)
		return JS_ThrowTypeError(ctx, "x25519_shared: secret_key must be 32 bytes");
	uint8_t *pk = JS_GetArrayBuffer(ctx, &pk_sz, argv[1]);
	if (!pk || pk_sz != 32)
		return JS_ThrowTypeError(ctx, "x25519_shared: peer_public must be 32 bytes");

	EVP_PKEY *privkey = EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, NULL, sk, 32);
	EVP_PKEY *pubkey = EVP_PKEY_new_raw_public_key(EVP_PKEY_X25519, NULL, pk, 32);
	if (!privkey || !pubkey) {
		EVP_PKEY_free(privkey); EVP_PKEY_free(pubkey);
		return JS_ThrowInternalError(ctx, "x25519_shared: load keys failed");
	}

	EVP_PKEY_CTX *dctx = EVP_PKEY_CTX_new(privkey, NULL);
	uint8_t shared[32];
	size_t shared_len = 32;
	int ok = 0;
	if (dctx && EVP_PKEY_derive_init(dctx) == 1 &&
	    EVP_PKEY_derive_set_peer(dctx, pubkey) == 1 &&
	    EVP_PKEY_derive(dctx, shared, &shared_len) == 1) {
		ok = 1;
	}
	EVP_PKEY_CTX_free(dctx);
	EVP_PKEY_free(privkey);
	EVP_PKEY_free(pubkey);
	if (!ok) return JS_ThrowInternalError(ctx, "x25519_shared: derive failed");
	return JS_NewArrayBufferCopy(ctx, shared, shared_len);
}

static void register_openssl_crypto(JSContext *ctx, JSValue crypt) {
	JS_SetPropertyStr(ctx, crypt, "aesGcmEncrypt", JS_NewCFunction(ctx, js_crypt_aes_gcm_encrypt, "aesGcmEncrypt", 4));
	JS_SetPropertyStr(ctx, crypt, "aesGcmDecrypt", JS_NewCFunction(ctx, js_crypt_aes_gcm_decrypt, "aesGcmDecrypt", 5));
	JS_SetPropertyStr(ctx, crypt, "ed25519Keypair", JS_NewCFunction(ctx, js_crypt_ed25519_keypair, "ed25519Keypair", 0));
	JS_SetPropertyStr(ctx, crypt, "ed25519Sign", JS_NewCFunction(ctx, js_crypt_ed25519_sign, "ed25519Sign", 2));
	JS_SetPropertyStr(ctx, crypt, "ed25519Verify", JS_NewCFunction(ctx, js_crypt_ed25519_verify, "ed25519Verify", 3));
	JS_SetPropertyStr(ctx, crypt, "x25519Keypair", JS_NewCFunction(ctx, js_crypt_x25519_keypair, "x25519Keypair", 0));
	JS_SetPropertyStr(ctx, crypt, "x25519Shared", JS_NewCFunction(ctx, js_crypt_x25519_shared, "x25519Shared", 2));
}
#endif
