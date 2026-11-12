# IDE for Claude

Mod Claude Code : un IDE pour suivre, relire et commenter les modifications de Claude, sans quitter la session.

Pendant que Claude travaille, IDE for Claude note chaque fichier qu'il touche (`Edit`, `Write`), garde la version d'avant et affiche le diff. Tu relis, tu acceptes, tu rejettes ou tu commentes : ta review part avec ton prochain prompt.

## Deux interfaces

| Commande | Interface |
|---|---|
| `/ide-for-claude [fichier]` | Panneau dans le terminal, façon nano, avec le diff coloré des modifs de Claude |
| `/ide-for-claude-web` | Page dans le navigateur avec Monaco (l'éditeur de VS Code) |

On peut passer de l'une à l'autre : la touche `w` du panneau ouvre la page web sur le fichier en cours.

## Le panneau terminal

- Onglets des fichiers modifiés par Claude (touches `1` à `9`)
- Diff coloré avec coloration syntaxique, lignes inchangées repliées
- Arbre du projet, avec les dossiers touchés par Claude mis en avant
- Édition et sauvegarde directement dans le panneau

| Touche | Action |
|---|---|
| `1`…`9` | Ouvrir un fichier modifié par Claude |
| `e` / `v` | Éditer / revenir à la vue |
| `s` | Sauver |
| `z` | Annuler la dernière sauvegarde |
| `a` | Tout voir / replier les lignes inchangées |
| `t` | Afficher ou cacher l'arbre |
| `r` | Recharger le fichier depuis le disque |
| `w` | Ouvrir dans le navigateur |
| `q` | Quitter |

## Le mode navigateur

- Diff des modifications de Claude (une ou deux colonnes, lignes inchangées repliées)
- Review façon GitHub : ✅ accepter (visuel), ❌ rejeter un bloc ou un fichier, 💬 commenter une ligne
- `Ctrl+L` : joindre la sélection pour Claude
- Commentaires, rejets et extraits partent discrètement avec le prochain prompt, ou avec « Envoyer maintenant »
- Historique prompt par prompt, diff de toute la session, ↶ revenir avant un prompt
- Badges git et comparaison avec `git HEAD`
- Activité de Claude en direct, son et notification de fin
- Préférences gardées par projet

| Raccourci | Action |
|---|---|
| `Ctrl+P` | Ouvrir un fichier |
| `Ctrl+Shift+F` | Chercher dans le projet |
| `Ctrl+S` | Sauver |
| `Ctrl+L` | Joindre la sélection à la review |
| `Ctrl+Entrée` | Valider un commentaire |

Sur macOS, `Cmd` marche à la place de `Ctrl`.

## Prérequis

- Claude Code 2.1.275 ou plus récent (installation en une commande, mods / hooks modules)
- Node.js 18 ou plus récent pour le mode navigateur
- Internet pour charger Monaco depuis le CDN jsDelivr
- `xdg-open` (Linux) ou `open` (macOS) pour ouvrir le navigateur automatiquement. Ailleurs, copier l'adresse affichée par `/ide-for-claude-web`

## Installation

Une seule commande, à copier-coller dans un terminal :

```sh
claude plugin install ide-for-claude --marketplace DIGYSKY/IDE-for-Claude
```

Ou, directement dans Claude Code :

```
/plugin install ide-for-claude --marketplace DIGYSKY/IDE-for-Claude
```

La commande ajoute la marketplace `digysky` (ce dépôt) puis installe la mod. Redémarre ensuite Claude Code et tape `/ide-for-claude`.

Pour mettre à jour :

```sh
claude plugin marketplace update digysky && claude plugin update ide-for-claude@digysky
```

<details>
<summary>Installation manuelle (sans marketplace)</summary>

Cloner le dépôt, par exemple dans `~/.claude/mods/ide-for-claude` :

```sh
git clone https://github.com/DIGYSKY/IDE-for-Claude.git ~/.claude/mods/ide-for-claude
```

Puis l'ajouter dans `~/.claude/settings.json` :

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/ide-for-claude"
  }
}
```

Ou, pour une seule session : `claude --plugin-dir ~/.claude/mods/ide-for-claude`.

</details>

## Sécurité

Chaque session Claude lance son propre serveur local, sans dépendance :

- il écoute seulement sur `127.0.0.1`, sur un port libre choisi au hasard ;
- chaque requête doit porter une clé aléatoire, donnée dans l'adresse ouverte par `/ide-for-claude-web` ;
- il refuse les requêtes dont l'en-tête `Host` n'est pas `127.0.0.1` ou `localhost` ;
- il ne lit et n'écrit que dans le dossier du projet.

Plusieurs projets peuvent donc tourner en même temps. Ne partage pas l'adresse complète : la clé donne accès en lecture et en écriture aux fichiers du projet.

## Tests

```sh
claude plugin test .
```

## Structure

```
.claude-plugin/plugin.json   manifeste
.claude-plugin/marketplace.json  marketplace « digysky » pour l'installation
hooks/register.tsx           la mod : panneau, suivi des modifs, historique, review
hooks/syntax.ts              coloration syntaxique du panneau terminal
server/server.mjs            serveur local du mode navigateur (sans dépendance)
server/index.html            page web (Monaco)
types/index.d.ts             types de l'état de la mod
tests/                       tests
```

## Licence

[MIT](LICENSE)
