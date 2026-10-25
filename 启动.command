#!/bin/bash
# macOS system Bash 3.2 compatible. Uses only the project's offline Node runtime.
set -u
set -o pipefail

ROOT="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1
PORT=4173
OPEN_BROWSER=1
LOCK_HELD=0
RUNTIME_LOCK=''

usage() {
  printf '%s\n' 'MC3DBeads 本地网站' '用法：./启动.command [--port 4173] [--no-browser]' \
    '服务仅监听 127.0.0.1；不联网下载或安装软件。'
}
fail() {
  printf '\n启动失败：%s\n' "$1" >&2
  if [ -n "${LOG_FILE:-}" ]; then printf '日志：%s\n' "$LOG_FILE" >&2; fi
  exit 1
}
release_runtime_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -f -- "$RUNTIME_LOCK/pid"
    rmdir -- "$RUNTIME_LOCK" 2>/dev/null || true
    LOCK_HELD=0
  fi
}
trap release_runtime_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      [ "$#" -ge 2 ] || fail '--port 后需要端口号。'
      PORT=$2; shift 2 ;;
    --port=*) PORT=${1#--port=}; shift ;;
    --no-browser) OPEN_BROWSER=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "未知参数：$1" ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) fail '端口必须是 1–65535 的整数。' ;; esac
[ "${#PORT}" -le 5 ] || fail '端口必须是 1–65535 的整数。'
PORT=$((10#$PORT))
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail '端口必须是 1–65535 的整数。'
[ "$(uname -s)" = Darwin ] || fail '这个启动器用于 macOS；Windows 请使用对应的本地启动脚本。'
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail '不支持当前 Mac 处理器架构，需要 arm64 或 x86_64。' ;;
esac

CACHE="$ROOT/.cache"
mkdir -p -- "$CACHE/runtime" || fail '无法创建项目内的 .cache 目录。'
LOG_FILE="$CACHE/server-$PORT.log"
touch "$LOG_FILE" || fail '无法写入启动日志。'
for required in scripts/server.mjs public/index.html public/data/catalog.json public/data/palette.json public/vendor/three.module.js; do
  [ -f "$ROOT/$required" ] || fail "便携文件不完整，缺少：$required。请保留完整项目目录。"
done

VERSION=''
[ -f "$ROOT/runtime/node-version.txt" ] || fail '缺少 runtime/node-version.txt；请使用带离线运行环境的完整版本。'
IFS= read -r VERSION < "$ROOT/runtime/node-version.txt" || true
VERSION=${VERSION%$'\r'}
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'runtime/node-version.txt 中的版本号无效。'
RUNTIME_DIR="node-$VERSION-darwin-$ARCH"
ARCHIVE_NAME="$RUNTIME_DIR.tar.gz"
ARCHIVE="$ROOT/runtime/$ARCHIVE_NAME"
NODE="$CACHE/runtime/$RUNTIME_DIR/bin/node"

if [ ! -f "$NODE" ]; then
  if [ ! -f "$ARCHIVE" ] && [ -f "$ROOT/runtime/bin/node" ]; then
    NODE="$ROOT/runtime/bin/node"
  else
    [ -f "$ARCHIVE" ] || fail "缺少适合此 Mac 的离线运行环境：runtime/$ARCHIVE_NAME。不会联网下载。"
    [ -f "$ROOT/runtime/SHASUMS256.txt" ] || fail '缺少运行环境校验文件 runtime/SHASUMS256.txt。'
    RUNTIME_LOCK="$CACHE/runtime/.extract-$ARCH.lock"
    lock_deadline=$((SECONDS+20))
    while ! mkdir -- "$RUNTIME_LOCK" 2>/dev/null; do
      # Recover only a lock whose recorded owner no longer exists; no process is killed.
      owner=''
      if [ -f "$RUNTIME_LOCK/pid" ]; then IFS= read -r owner < "$RUNTIME_LOCK/pid" || true; fi
      case "$owner" in
        ''|*[!0-9]*) ;;
        *) if ! kill -0 "$owner" 2>/dev/null; then
             rm -f -- "$RUNTIME_LOCK/pid"
             rmdir -- "$RUNTIME_LOCK" 2>/dev/null || true
           fi ;;
      esac
      [ "$SECONDS" -lt "$lock_deadline" ] || fail '另一个启动器正在准备运行环境；请稍后重试。'
      sleep .2
    done
    LOCK_HELD=1
    printf '%s\n' "$$" > "$RUNTIME_LOCK/pid"
    if [ ! -f "$NODE" ]; then
      expected="$(awk -v wanted="$ARCHIVE_NAME" '$2 == wanted { print tolower($1); exit }' "$ROOT/runtime/SHASUMS256.txt")"
      [[ "$expected" =~ ^[[:xdigit:]]{64}$ ]] || fail "校验文件没有 $ARCHIVE_NAME 的有效 SHA-256。"
      actual="$(shasum -a 256 "$ARCHIVE" 2>>"$LOG_FILE")" || fail '无法计算运行环境校验值。'
      actual=${actual%% *}
      [ "$actual" = "$expected" ] || fail '离线 Node 归档校验失败；请重新取得完整归档，原文件已保留。'
      listing="$(tar -tzf "$ARCHIVE" 2>>"$LOG_FILE")" || fail '离线 Node 归档无法读取。'
      printf '%s\n' "$listing" | awk -v prefix="$RUNTIME_DIR/" '
        ($0 != substr(prefix,1,length(prefix)-1) && index($0,prefix) != 1) || /(^|\/)\.\.(\/|$)/ { bad=1 }
        END { exit bad }
      ' || fail '离线 Node 归档的目录结构异常，已停止解包。'
      STAGE="$CACHE/runtime/.extract-$ARCH-$$"
      mkdir -- "$STAGE" || fail '无法创建运行环境临时目录。'
      printf '正在准备 %s 的离线运行环境…\n' "$ARCH"
      tar -xzf "$ARCHIVE" -C "$STAGE" >>"$LOG_FILE" 2>&1 || fail '离线 Node 解包失败，详情见日志。'
      [ -f "$STAGE/$RUNTIME_DIR/bin/node" ] || fail '归档中缺少 Node 可执行文件。'
      [ ! -e "$CACHE/runtime/$RUNTIME_DIR" ] || fail '缓存运行环境不完整，请检查 .cache/runtime 中对应版本目录。'
      mv -- "$STAGE/$RUNTIME_DIR" "$CACHE/runtime/$RUNTIME_DIR" || fail '无法保存解包后的运行环境。'
      rmdir -- "$STAGE" 2>/dev/null || true
    fi
    release_runtime_lock
  fi
fi
chmod u+x "$NODE" 2>>"$LOG_FILE" || fail '无法设置项目内 Node 的执行权限。'
node_version="$("$NODE" --version 2>>"$LOG_FILE")" || fail '无法执行项目内 Node；请检查 Mac 架构、系统兼容性及执行权限。'
[ "$node_version" = "$VERSION" ] || fail "运行环境版本不符：需要 $VERSION，实际为 $node_version。"

URL="http://127.0.0.1:$PORT"
healthy() {
  local body
  body="$(curl -q --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 1 "$URL/__mc3dbeads_health" 2>/dev/null)" || return 1
  printf '%s' "$body" | "$NODE" -e '
    const path=require("node:path");let body="";
    process.stdin.setEncoding("utf8");process.stdin.on("data",x=>body+=x);
    process.stdin.on("end",()=>{try{
      const health=JSON.parse(body),root=path.resolve(process.argv[1]),port=Number(process.argv[2]);
      process.exit(health.app==="MC3DBeads"&&typeof health.root==="string"&&path.resolve(health.root)===root&&health.port===port?0:1);
    }catch{process.exit(1)}});
  ' "$ROOT" "$PORT" 2>/dev/null
}
show_site() {
  printf '\n%s\n%s\n' "$1" "$URL"
  printf '项目：%s\n日志：%s\n' "$ROOT" "$LOG_FILE"
  if [ "$OPEN_BROWSER" -eq 1 ]; then
    open "$URL" 2>>"$LOG_FILE" || printf '网站已就绪，但未能打开浏览器；请手动访问上面的地址。\n' >&2
  fi
}

if healthy; then show_site '已复用这个项目正在运行的本地网站。'; exit 0; fi
"$NODE" -e '
  const net=require("node:net");const socket=net.createConnection({host:"127.0.0.1",port:Number(process.argv[1])});
  socket.once("connect",()=>{socket.destroy();process.exit(0)});
  socket.once("error",error=>process.exit(error.code==="ECONNREFUSED"?1:2));
  socket.setTimeout(1000,()=>{socket.destroy();process.exit(2)});
' "$PORT" 2>>"$LOG_FILE"
probe=$?
[ "$probe" -ne 0 ] || fail "端口 $PORT 已被其他程序或其他项目占用；没有终止任何进程。请改用 --port 其他端口。"
[ "$probe" -eq 1 ] || fail "无法确认端口 $PORT 是否可用；没有启动或终止任何服务。"

printf '\n启动本地网站：%s\n' "$URL" >> "$LOG_FILE"
nohup "$NODE" "$ROOT/scripts/server.mjs" --port "$PORT" </dev/null >>"$LOG_FILE" 2>&1 &
server_pid=$!
printf '%s\n' "$server_pid" > "$CACHE/server-$PORT.pid"
deadline=$((SECONDS+12))
while [ "$SECONDS" -lt "$deadline" ]; do
  if healthy; then show_site 'MC3DBeads 本地网站已启动。'; exit 0; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    # A simultaneous launcher may have won the same port with this exact project.
    sleep .2
    if healthy; then show_site '已复用这个项目正在运行的本地网站。'; exit 0; fi
    fail '网站进程已退出；可能是端口冲突或文件错误，详情见日志。没有终止其他进程。'
  fi
  sleep .2
done
fail "进程 $server_pid 未在限定时间内通过项目与端口健康检查；请查看日志。未终止任何进程。"
