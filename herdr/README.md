# Herdr

Herdr와 Pi 공식 연동 확장을 같은 flake 입력으로 고정한다. `config.toml`과
`bin/workspace`는 home-manager의 `mkOutOfStoreSymlink`로 연결하고, 공식 확장은
Herdr 입력 소스의 `src/integration/assets/pi/herdr-agent-state.ts`에 연결한다.
워크스페이스 기록, 소켓, 로그 등 실행 상태는 `~/.config/herdr/`에 유지한다.

## 사용

```zsh
cd ~/projects/my-app
hw
# 다른 경로를 지정할 수도 있다.
hw ~/projects/another-app
```

`hw`는 지정한 경로와 같은 cwd의 터미널이 있는 workspace를 찾아 전환하고,
없으면 만든다. 경로는 심볼릭 링크를 해석한 절대 경로로 비교한다. 같은 이름의
다른 디렉터리는 별도 workspace로 열린다. Herdr 안에서 실행하면 workspace만
전환한다. 모든 터미널의 cwd를 바꾼 경우에는 원래 경로의 workspace가 새로
생성될 수 있다.

각 탭에서 `pi`를 실행한다. 기본 단축키의 prefix는 `Ctrl+b`이며, prefix를 누른
다음 `c`로 새 탭, `n`/`p`로 탭 전환, `v`/`-`로 화면 분할, `q`로 detach한다.
detach 후 `hw` 또는 `herdr`로 다시 접속하면 실행 중인 Pi를 계속 사용할 수 있다.

```sh
herdr integration status
herdr agent list
```

서버 재시작 시에는 공식 확장이 보고한 Pi 세션을 다시 연다. 이전 프로세스나
진행 중이던 작업 자체를 유지하는 방식은 아니다.

## 업데이트

`flake.nix`의 Herdr 릴리스 태그를 변경한 뒤 다음 명령으로 잠금과 빌드를 갱신한다.

```sh
nix flake update herdr --flake ~/.dotfiles
nix build ~/.dotfiles#herdr
sudo darwin-rebuild switch --flake ~/.dotfiles#mbp
```

실행 파일과 Pi 확장은 Nix와 home-manager가 관리한다. `herdr update`와
`herdr integration install pi` 대신 위 절차로 업데이트한다.
