# IDE for Claude

Mod Claude Code : un IDE pour suivre, relire et commenter les modifications de Claude, sans quitter la session.

Pendant que Claude travaille, IDE for Claude note chaque fichier qu'il touche, garde la version d'avant et affiche le diff. Tu relis, tu acceptes, tu rejettes ou tu commentes : ta review part avec ton prochain prompt.

## Ce qui est suivi

- `Edit`, `Write` et `NotebookEdit` : chaque fichier touché, avec son contenu d'avant.
- `Bash` : les fichiers créés ou modifiés par une commande (`sed -i`, `mv`, un formateur, un script…). Dans un dépôt git, la mod compare `git status` avant et après la commande ; ailleurs, elle parcourt le projet (jusqu'à 2 000 fichiers). Un fichier supprimé est signalé, sans diff.
- Les sous-agents : chaque modif indique l'agent qui l'a faite, dans l'historique et au survol des onglets.

Limites : une commande lancée en arrière-plan n'est vue que pour ce qu'elle a changé avant de rendre la main. Un fichier que tu modifies toi-même pendant qu'une commande Bash tourne est compté comme une modif de Claude.

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
- S'ouvre tout seul à la première modif de Claude (si la page web n'est pas ouverte). Une fois fermé (croix, Échap ou `q`), il ne se rouvre plus de la session avant un `/ide-for-claude`

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

### Relire les modifs de Claude

- Diff des modifications de Claude (une ou deux colonnes, lignes inchangées repliées)
- Review façon GitHub : ✅ accepter un bloc ou tout le fichier, ❌ rejeter un bloc ou un fichier, 💬 commenter une ligne
- Un fichier dont tous les blocs sont acceptés sort de la revue de ce prompt : il repasse en édition normale et son onglet se ferme comme les autres. Une nouvelle modif de Claude le remet en revue
- ✅ Tout valider, dans l'en-tête et en haut de l'historique : tous les fichiers encore en revue en sortent, tous prompts confondus
- 🕓 Historique prompt par prompt : le prompt en cours est mis en évidence, avec ✅ Tout accepter et ❌ Tout refuser (ses fichiers reviennent à leur état d'avant, Claude est prévenu) ; un ancien prompt pas encore validé est marqué « n à valider » ; diff de toute la session, ↶ revenir avant un prompt plus ancien. Chaque fichier indique le sous-agent (🤖) et l'outil (⚙️ Bash, 📓 notebook) quand ce n'est pas Claude avec `Edit`/`Write`
- Commentaires, rejets, idées et extraits partent avec le prochain prompt, ou avec « Envoyer maintenant »
- Badges git et comparaison avec `git HEAD`

### Parler à Claude depuis la page

- **Éditeur de prompt** en bas de la page, avec autocomplétion :
  - `@fichier` : le contenu du fichier est joint (au-delà de 30 Ko, seulement son nom)
  - `@fichier:12-30` : ces lignes sont jointes ; `Ctrl+L` dans le code insère la sélection
  - `/commande` : en tête de prompt, la commande ou le skill est lancé comme dans le terminal ; ailleurs, Claude est invité à s'en servir
  - `#i3` : l'idée n° 3 de la boîte à idées est jointe et passe « en cours »
- `Ctrl+Entrée` envoie ; `↑` et `↓` rappellent les prompts déjà envoyés ; le brouillon est gardé
- **File d'attente** : un prompt envoyé pendant que Claude travaille attend son tour et part quand Claude a fini. On peut le retirer, le reprendre dans l'éditeur ou l'envoyer tout de suite
- **Plan de Claude** en direct, au-dessus de l'éditeur : sa liste de tâches, l'étape en cours, la progression

Le contexte joint (lignes, fichiers, idées, revue) apparaît sous le prompt, dans le terminal aussi : Claude Code ne permet pas à une mod de le joindre à part pour un prompt qu'elle envoie.

### Les outils de Claude

La mod donne à Claude des outils à lui :

| Outil | Ce que fait Claude |
|---|---|
| `idea_add` | Note une idée dans la boîte à idées, éventuellement rattachée à des lignes |
| `annotate` / `annotations_clear` | Pose (ou retire) des annotations dans le code : demande-lui « où est géré X ? » |
| `command_save` | Enregistre une commande dans l'exécuteur (lancer le projet, un serveur, les tests…) |
| `statusline_set` | Change la barre d'état quand tu le lui demandes |

### Les onglets

- 💡 **Boîte à idées** (par projet) : ajouter, étiqueter, filtrer (nouvelles, en cours, faites), modifier d'un double-clic, ✍ mentionner dans le prompt, 📎 joindre au prochain prompt. Clic droit sur du code → 💡 (ou `Ctrl+Alt+I`) pour partir d'une sélection
- 📍 **Annotations de Claude** : une liste par fichier ; un clic ouvre le fichier sur la ligne, surlignée avec un 📍 dans la marge
- ▶ **Commandes** : taper une commande et la lancer, en enregistrer (par projet), relancer, arrêter. Plusieurs peuvent tourner en même temps, un serveur de dev par exemple. 🖥 ouvre le terminal d'une commande : sa sortie en direct, ■ Arrêter, ↻ Relancer, 📎 joindre la fin de la sortie pour Claude. Les scripts de `package.json`, les tests détectés et les cibles du `Makefile` sont proposés

### ⚙️ Paramètres

- **Éditeur** : police, taille, tabulations, retour à la ligne, minimap, thème… et un `settings.json` façon VS Code (toutes les options `editor.*` de Monaco). « Importer mon settings.json de VS Code » reprend tes réglages `editor.*` de VS Code (ou Cursor)
- **IDE for Claude** : ouverture automatique du panneau, revue jointe au prompt, durée de conservation de l'historique, ouverture des fichiers modifiés, son de fin, modèle de la barre d'état
- **Claude Code** : les réglages de `/config`, appliqués tout de suite, et les fichiers `settings.json` (utilisateur, projet, local) à modifier directement. Le JSON est vérifié avant d'être écrit, et l'ancienne version est gardée en `.bak`

### Barre d'état

En bas à droite : modèle, part du contexte utilisée, coût de la session, branche git, étape en cours du plan… Le modèle se règle dans ⚙️ (variables `{model}` `{context}` `{tokens}` `{window}` `{cost}` `{branch}` `{plan}` `{queue}` `{review}` `{time}`), ou en le demandant à Claude.

### Raccourcis

| Raccourci | Action |
|---|---|
| `Ctrl+P` | Ouvrir un fichier |
| `Ctrl+Shift+F` | Chercher dans le projet |
| `Ctrl+S` | Sauver |
| `Ctrl+L` | Joindre la sélection au prompt |
| `Ctrl+Alt+I` | Nouvelle idée depuis la sélection |
| `Ctrl+Entrée` | Envoyer le prompt, valider un commentaire |
| `↑` / `↓` dans le prompt | Prompts précédents |

Sur macOS, `Cmd` marche à la place de `Ctrl`. Chrome peut garder `Cmd+L` pour sa barre d'adresse : la vraie touche `Ctrl+L` marche aussi.

## Ce qui est enregistré

| Quoi | Portée | Où |
|---|---|---|
| Historique des prompts, revue en cours, file d'attente, plan | par session : retrouvés en reprenant la conversation (`claude --resume`, la liste de `/resume`, `claude -c`) | `~/.claude/plugins/data/ide-for-claude/sessions/<session>.json`, effacé après 30 jours (réglable) |
| Idées, annotations, commandes enregistrées, prompts envoyés depuis la page | par projet | `~/.claude/plugins/data/ide-for-claude/projects/<dossier>-<empreinte>.json` |
| Page web : onglets ouverts, fichier affiché, position dans chaque fichier, colonnes, replis, panneau latéral, brouillon du prompt, notifications | par projet | stockage de la mod (`$.store`) |
| Réglages de l'éditeur et d'IDE for Claude, panneau terminal | pour tous les projets | stockage de la mod (`$.store`) |

## Prérequis

- Claude Code 2.1.275 ou plus récent (installation en une commande, mods / hooks modules)
- Node.js 18 ou plus récent pour le mode navigateur
- Internet pour charger Monaco depuis le CDN jsDelivr
- Ouverture automatique du navigateur : `xdg-open` (Linux), `open` (macOS) ou `rundll32` (Windows). Sinon, copier l'adresse affichée par `/ide-for-claude-web`

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

Plusieurs projets peuvent donc tourner en même temps. Ne partage pas l'adresse complète : la clé donne accès en lecture et en écriture aux fichiers du projet, permet de lancer des commandes dans le dossier du projet, d'envoyer des prompts à Claude et de modifier les réglages de Claude Code.

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
