# 에이전트 지침

## 프로젝트 개요

Apple Silicon(aarch64-darwin) macOS의 dotfiles를 **nix-darwin**, **home-manager**, **nix-homebrew**로 관리한다.

## 파일 구조

- `flake.nix` — 시스템 패키지, macOS 기본 설정, Homebrew(brews/casks/masApps), nix-darwin 설정을 정의하는 메인 flake
- `home.nix` — 사용자 프로그램(zsh, git, vim) 설정과 `mkOutOfStoreSymlink`를 이용한 dotfile 심볼릭 링크를 관리하는 home-manager 설정
- `zshrc` — home-manager의 `initContent`로 불러오는 Zsh 설정. 별칭, 환경 변수, mise 활성화 설정 포함
- `karabiner.json` — Karabiner Elements 설정. home-manager를 통해 `~/.config/karabiner/`에 심볼릭 링크로 연결
- `mise/` — Node.js, Ruby, Java, Terraform, CocoaPods의 전역 mise 버전 설정
- `flake.lock` — flake 입력의 버전을 고정하는 파일. 직접 수정하지 않는다.

## 업데이트 및 변경 사항 적용

`zshrc`에 정의된 별칭을 사용한다.

```zsh
# flake 입력을 최신 버전으로 업데이트하고 flake.lock 갱신
nxu

# mbp 구성을 빌드하고 시스템에 적용
nxr
```

각 별칭의 실제 명령은 다음과 같다. 별칭을 사용할 수 없는 셸에서는 직접 실행한다.

```sh
# nxu
nix flake update --flake ~/.dotfiles

# nxr
sudo darwin-rebuild switch --flake ~/.dotfiles#mbp
```

패키지와 flake 의존성을 업데이트해 적용하려면 `nxu` 실행 후 `nxr`을 실행한다. 설정 변경만 적용하려면 `nxr`을 실행한다.

## 작업 규칙

- CLI 도구는 nix(`flake.nix`의 `environment.systemPackages`)로 설치해 `flake.lock`으로 버전을 고정하고 롤백할 수 있게 한다. 프로젝트마다 버전이 달라지는 런타임과 도구는 mise로 관리한다. Homebrew는 GUI 앱(`homebrew.casks`)과 Mac App Store 자동화(`mas`)에 사용한다.
- Mac App Store 앱은 `homebrew.masApps`에 추가한다. 형식은 `이름 = App Store ID`이다.
- dotfile 설정이 있는 사용자 프로그램은 `home.nix`의 `programs.<name>`으로 관리한다.
- 이 저장소의 dotfile은 복사하지 않고 `mkOutOfStoreSymlink`로 연결하므로 원본 파일의 수정이 연결된 경로에 즉시 반영된다.
- Nix 파일은 `nixfmt`으로 포맷한다.
- 머신 구성 이름은 `mbp`(`darwinConfigurations.mbp`)이다.
