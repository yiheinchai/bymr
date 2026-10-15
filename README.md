# Backyard Monsters Refitted in the browser

Play at **https://yiheinchai.com/bymr/** on a phone or computer. On a phone, use "Add to Home
screen" for a full-screen app.

This is a static build of the browser client from
[yiheinchai/backyard-monsters-refitted](https://github.com/yiheinchai/backyard-monsters-refitted)
(`pwa/` there explains how it works): the game client (`bymr.swf`, release v1.7.9-beta with the
browser changes) running in a patched build of [Ruffle](https://ruffle.rs). It plays on the official
Backyard Monsters Refitted servers, so sign in with your Backyard Monsters Refitted account.

## Updates

The official servers turn away an outdated client, so the game here is rebuilt automatically.
Every three hours, `.github/workflows/update-game.yml` runs `build/update.sh`, which:

1. finds the newest upstream release tag
   ([bym-refitted/backyard-monsters-refitted](https://github.com/bym-refitted/backyard-monsters-refitted));
2. stops if that's already live (`build/client-version`), or if the game server doesn't accept it
   yet;
3. otherwise applies the browser changes (`build/web-client.patch`) to that release, compiles it
   with the Apache Flex SDK, and commits the new `bymr.swf`, which publishes it.

If the patch no longer applies to a new release, the run fails (GitHub emails the repository
owner) and the current version stays up. To run it straight away, use "Run workflow" on the
Actions tab. GitHub pauses scheduled workflows in a repository with no activity for 60 days.

`build/web-client.patch` is the client part of the browser changes:
`git diff <upstream main it was based on> <branch> -- client/scripts` in the game repository.
Regenerate it when those change.

Ruffle is dual-licensed under MIT and Apache 2.0 (`ruffle/LICENSE_*`).
