(() => {	
  socket = io();
  let map;
  let savedUser;

  fetch('./map')
  .then((response) => response.json())
  .then((data) => {
  	map = data;
  });

  socket.on('supporters', function (supporters){
    const ul = document.getElementById('supporters');
    ul.innerHTML = '';
    
    for(let supporter of supporters){
      let li = document.createElement('li');
      
      li.appendChild(document.createTextNode(supporter));
      ul.appendChild(li);
    }
  });

  socket.on('loginError', function(error){
    document.getElementById('loginError').innerText = error;
  });
  
  socket.on('loggedIn', function(user){
    savedUser = user;
    
    const button = document.getElementById('login');
    
    button.innerText = 'Play Birdwatch';
    button.removeAttribute('onclick');
    button.addEventListener('click', startGame);
  });

  socket.on('gameUpdate', function(updateObj){
    updateGame(updateObj);
  });

  socket.on('message', function(message){
    const text = document.getElementById('text');
    text.innerText += `${message}\n\n`;
    scroll();
  });
  
  document.getElementById('actionInput').addEventListener('keyup', function(event) {
    if(event.keyCode === 13){
      event.preventDefault();
      sendAction();
    }
  });

  socket.on('chatMsg', function (msgObj){
    newChat(msgObj);
  });

  socket.on('leaderboard', function (leaderboard){
    updateLeaderboard(leaderboard);
  });

  socket.on('playerCount', function (count){
    document.getElementById('chatInput').placeholder = `Players online: ${count}`;
  });

  socket.on('reload', function (){
    window.location.reload();
  });

  function startGame(){
    if(socket.connected == false) return window.location.reload();
    
    document.getElementById('game').style.visibility = 'visible';
    updateGame({"user": savedUser, "notify": true});
    
    document.getElementById('startMenu').style.visibility = 'hidden';
  }
  
  function sendAction(){
    const text = document.getElementById('text');    
    const input = document.getElementById('actionInput');

    if(socket.connected == false){
      text.innerHTML += '<i>This game has been disconnected because you logged in somewhere else. If you want to continue playing on this tab, just reload!</i><br><br>';

      input.value = '';
      return scroll();
    }
    
    let action = input.value;

    if(action == '') return;
    if(action.toLowerCase() == 'blackjack help') return blackjackHelp();
    if(['north', 'east', 'south', 'west'].includes(action.toLowerCase())) action = `move ${action}`;
    
    let args = action.split(' ');
    const command = args[0];
    args.shift();
    input.value = '';
  
    const actionObj = {
      command: command,
      args: args,
      hour: new Date().getHours()
    };

    if(command.toLowerCase() == 'help') return help();
    if(command.toLowerCase() == 'location') return location();
    if(command.toLowerCase() == 'balance') return balance();
    if(command.toLowerCase() == 'inventory') return inventory();
    if(command.toLowerCase() == 'stats') return stats();
    if(command.toLowerCase() == 'alliances') return alliances();
    if(command.toLowerCase() == 'clear') return clear();
    if(command.toLowerCase() == 'clearchat') return clearChat();
    if(command.toLowerCase() == 'togglechat') return toggleChat();

    socket.emit('action', actionObj);
  }

  function help(){
    const text = document.getElementById('text');
    
    text.innerText += `Use commands to navigate and interact with the game!
    Global commands:
    "location": Reminds you of your surroundings.
    "stats": List your current stats. (Health, strength, speed, etc.)
    "balance": Tells you how much money you have.
    "inventory": Shows you what items you own.
    "move {direction}": Moves you in a given direction. (North, South, East, West) You can also just type the direction you want to move in, Ex. "north"
    "alliances": Lists your alliances.
    "eat {item}": Consume a food item to heal. Must have item in inventory.
    "playersonline": Lists all connected players.
    "playerinfo {username}": Get some helpful information about another player's alliance, level, etc.
    "clear": Clears the terminal. (The text you are currently reading)
    "clearchat": Clears the chat.
    "togglechat": Toggles the chat.

    "reset": Resets your account. THIS IS PERMANENT!
    
    NOTE: There are other location-specific commands that will be explained by other characters.\n\n`;
    
    scroll();
  }
  
  function blackjackHelp(){
    const text = document.getElementById('text');
    
    text.innerText += 'The goal of blackjack is to get a higher point value than the dealer, without going over 21. You will be dealt two face up cards, and the dealer will have one face up card and one face down card. Your point value is the value of each of your cards added up, with these values:\nNumber cards: Worth their number (Ex. 2 of spades is worth 2 points)\nFace cards (J, Q, K): All worth 10 points\nAces: Can be worth either 1 or 11 points, and can be changed whenever\nTo get more points, you can \"hit\". When you hit, you will be given another card from the top of the deck. If your point value goes over 21, or \"bust\", at any time, you instantly lose your bet. On your first turn, you have the option to \"double\". Doing so doubles your bet, and hits your hand once before the dealer turns his cards face up. However, if you don\'t have enough money to double your bet, you will be unable to double. Once you are done hitting, you can \"stand\", and the dealer shows his hidden card, and hits until he has at least 17 points. (This also happens immediately after doubling.) The dealer can also bust. Once the dealer and player are done hitting, whomever has the higher score without busting wins the bet. There is also a chance of getting a \"blackjack\", or being dealt and Ace and a Ten or Face card, which pays you 1.5x your original bet.\n\nCommands:\nStart game: \"blackjack {bet amount}\"\nHit: \"hit\"\nDouble:\n\"double\"\nStand: \"stand\"';
    
    scroll();
  }

  function location(){
    const text = document.getElementById('text');
    const location = map[savedUser.game.location];

    let addedMessage = '\n';
    
    Object.keys(location.neighbors).forEach(function(key){
      const neighbor = map[location.neighbors[key]];
      addedMessage +=`\n${capitalizeFirstLetter(key)}: ${neighbor.name}`;
    });
    
    for(let enemyID in location.enemies){
      const enemy = location.enemies[enemyID];
      
      if(!(savedUser.game.defeatedEnemies.includes(enemy.name))) addedMessage += `\n${capitalizeFirstLetter(enemyID)} blocks travel to the ${enemy.blockedDirection}! ("fight ${enemyID}")`;
    }
      
    text.innerText += `Entered ${map[savedUser.game.location].name}.\n${map[savedUser.game.location].text}${addedMessage}\n\n`;
      
    scroll();
  }

  function balance(){
    const text = document.getElementById('text');
    
    text.innerText += `Current balance: $${savedUser.game.money}\n\n`;
    
    scroll();
  }

  function stats(){
    const text = document.getElementById('text');
    const elixirTimer = (45 - Math.ceil((Date.now() - savedUser.game.lastElixir) / (1000 * 60)));
    
    text.innerText += `Health: ${savedUser.game.health}/${savedUser.game.maxHealth + savedUser.game.maxHealthBuff}\nLevel: ${savedUser.game.level} (${savedUser.game.xp}/${savedUser.game.xpRequired}XP)\nPrestige: ${savedUser.game.prestige} (Next prestige available at level ${(50 + (savedUser.game.prestige * 10))}!)\nStrength: ${savedUser.game.damage}/${(savedUser.game.level + 1) * 10} (+ ${savedUser.game.damageBuff} in items)\nSpeed: ${savedUser.game.speed}/${savedUser.game.level * 5} (+ ${savedUser.game.speedBuff} in items)\n${(elixirTimer <= 45)? `Elixer buff remaining for: ${elixirTimer} minute${(elixirTimer == 1)? '' : 's'}` : ''}\n\n`;
    
    scroll();
  }

  function inventory(){
    const inventory = savedUser.game.items;
    let textToDisplay = '';

    if(inventory.length <= 0){
      textToDisplay = 'Your inventory is empty!';
    } else {
      textToDisplay = 'Your items:';
      for(let item of inventory){
        textToDisplay += `\n${item}`;
      }
    }

    if(savedUser.game.items.includes('Pouch')) textToDisplay += `\nYou also have ${formatNumber(savedUser.game.food)}HP worth of food in your pouch!`;
    
    const text = document.getElementById('text');
    
    text.innerText += `${textToDisplay}\n\n`;
    
    scroll();
  }

  function alliances(){
    const list = savedUser.game.alliances;
    let textToDisplay = '';

    if(list.length <= 0){
      textToDisplay = 'You have no alliances!';
    } else {
      textToDisplay = 'Your alliances:';
      for(let alliance of list){
        textToDisplay += `\n${capitalizeFirstLetter(alliance)}`;
      }
    }
    
    const text = document.getElementById('text');
    
    text.innerText += `${textToDisplay}\n\n`;
    
    scroll();
  }

  function clear(){
    document.getElementById('text').innerHTML = '';
    scroll();
  }

  function updateGame(updateObj){
    savedUser = updateObj.user;
    if(savedUser.game.items.includes('Map')) drawMap();
    
    if(updateObj.notify == true){
      location();
    }
  }

  function scroll(){
    const terminal = document.getElementById('terminal');
    terminal.scrollTop = terminal.scrollHeight;
  }

  function sendChat(){
    let toggled = JSON.parse(localStorage.getItem('chatToggled'));
    if(toggled == undefined) toggled = true;

    const input = document.getElementById('chatInput');

    if(toggled == false){
      let li = document.createElement('li');
      let badge = document.createElement('span');
      let msg = document.createElement('msg');
    
        
      badge.innerText = 'System: ';
      badge.style.color = '#F45B69';
    
      msg.innerText = 'You have chat disabled! Use the \"togglechat\" command to reenable it.';
      li.appendChild(badge);
      li.appendChild(msg);

      input.value = '';
    
      return document.getElementById('chat').appendChild(li);
    }
    
    const msg = input.value;
    
    if((msg.length < 1) || (msg.length > 199)) return;
  
    socket.emit('sendChat', msg);
    input.value = '';
  }
  
  function newChat(msgObj){
    let toggled = JSON.parse(localStorage.getItem('chatToggled'));
    if(toggled == undefined) toggled = true;

    if((toggled == false) && (msgObj.system == false)) return;
    
    const sender = msgObj.sender;
    const badgeColor = msgObj.badgeColor;
    
    let messages = document.getElementById('chat').children;

    while(messages.length >= 500){
      messages[0].remove();
      messages = document.getElementById('chat').children;
    }

    const chatBox = document.getElementById('chat');
    const wasScrolledToBottom = chatBox.scrollTop === (chatBox.scrollHeight - chatBox.offsetHeight);
  
    let li = document.createElement('li');
    let badge = document.createElement('span');
    let msg = document.createElement('msg');
  
      
    badge.innerText = `${sender}: `;
    badge.style.color = msgObj.badgeColor;
  
    msg.innerText = msgObj.msg;
    li.appendChild(badge);
    li.appendChild(msg);

    if((savedUser.game.location == 'prestigeHall') && (msgObj.prestige == false) && (msgObj.system == false)){
      li.style.opacity = 0.5;
    }
  
    document.getElementById('chat').appendChild(li);

    if(wasScrolledToBottom == true) chatBox.scrollTop = chatBox.scrollHeight;
  }
  
  document.getElementById('chatInput').addEventListener('keyup', function(event) {
    if(event.keyCode === 13){
      event.preventDefault();
      sendChat();
    }
  });

  function clearChat(){
    const chatBox = document.getElementById('chat');
    
    chatBox.innerHTML = '';
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function toggleChat(){
    let toggled = JSON.parse(localStorage.getItem('chatToggled'));
    
    if(toggled == undefined) toggled = true;
    toggled = !toggled;

    if(toggled == false) clearChat();

    localStorage.setItem('chatToggled', toggled);

    const text = document.getElementById('text');
    text.innerText += `Chat now toggled ${(toggled == true)? 'ON' : 'OFF'}.\n\n`;
    scroll();
  }

  function updateLeaderboard(leaderboard){
    if((leaderboard.length < 1) || (!leaderboard)) return;
    
    const places = document.getElementById('leaderboard').getElementsByTagName('li');
    
    for(let place in places){
      const player = leaderboard[place];
      if(player){
        places[place].innerText = `${+place + 1}: [${player.prestige}] ${player.username} - $${formatNumber(player.money)}`;
      }
    }
  }

  function drawMap(){
    // The corners are too much to get in a one-liner, using another function
    let mapArray = [
      [getCornerName('north', 'west'), (map[savedUser.game.location].neighbors.north == undefined)? '' : map[map[savedUser.game.location].neighbors.north].name, getCornerName('north', 'east')],
      [(map[savedUser.game.location].neighbors.west == undefined)? '' : map[map[savedUser.game.location].neighbors.west].name, map[savedUser.game.location].name, (map[savedUser.game.location].neighbors.east == undefined)? '' : map[map[savedUser.game.location].neighbors.east].name],
      [getCornerName('south', 'west'), (map[savedUser.game.location].neighbors.south == undefined)? '' : map[map[savedUser.game.location].neighbors.south].name, getCornerName('south', 'east')]
    ];

    for(let row in mapArray){
      for(let location in mapArray[row]){
        let name = mapArray[row][location];

        name = name.replaceAll('Birdwatch', 'BW');
        name = name.replaceAll('Spawnpoint', 'Spawn Point');
        name = name.replaceAll('Cliffside', 'Cliff Side');
        name = name.replaceAll('Headquarters', 'HQ');
        name = name.replaceAll('Nighttime', 'Night Time');
        name = name.replaceAll('Courtyard', 'Court Yard')

        mapArray[row][location] = name;
      }
    }
    
    const tiles = document.getElementById('map').children;
    let currentTile = 0;
    
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        const location = mapArray[x][y];
        const tile = tiles[currentTile];
        
        if(location == ''){
          tile.style.visibility = 'hidden';
        } else {
          tile.style.visibility = 'visible';
          tile.innerText = location;
        }
        
        currentTile++;
      }
    }
  }

  function getCornerName(directionOne, directionTwo){
    // Swap direction if one does not exist
    if(map[savedUser.game.location].neighbors[directionOne] == undefined){
      let temp = directionOne;
      directionOne = directionTwo;
      directionTwo = temp;
    }

    if(map[savedUser.game.location].neighbors[directionOne] == undefined) return '';

    const cornerID = map[map[savedUser.game.location].neighbors[directionOne]].neighbors[directionTwo];
    
    return ((cornerID == undefined) || (!savedUser.game.discoveredLocations.includes(cornerID)))? '' : map[cornerID].name;
  }

  function formatNumber(number){
    if(!number) return number;
    return(number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  }

  function capitalizeFirstLetter(word){
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
})();