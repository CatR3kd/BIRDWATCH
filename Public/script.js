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
    for(let supporter of supporters){
      let ul = document.getElementById('supporters');
      ul.innerHTML = '';
      let li = document.createElement('li');
      li.appendChild(document.createTextNode(supporter));
      ul.appendChild(li);
    }
  });
  
  socket.on('loggedIn', function(user){
    savedUser = user;
    
    const button = document.getElementById('login');
    
    button.innerText = 'Play Birdwatch';
    button.removeAttribute('onclick');
    button.addEventListener("click", startGame);
  });

  socket.on('gameUpdate', function(updateObj){
    updateGame(updateObj);
  });

  socket.on('message', function(message){
    const text = document.getElementById('text');
    text.innerText = `${text.innerText}${message}\n\n`;
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

  socket.on('kicked', function (){
    window.location.reload();
  });

  function startGame(){
    document.getElementById('startMenu').style.visibility = 'hidden';
    document.getElementById('game').style.visibility = 'visible';
    updateGame({"user": savedUser, "notify": true});
  }
  
  function sendAction(){
    const input = document.getElementById('actionInput');
    const action = input.value;
    let args = action.split(' ');
    const command = args[0];
    args.shift();
    input.value = '';
  
    const actionObj = {
      command: command,
      args: args
    };

    if(command.toLowerCase() == 'help') return help();
    if(command.toLowerCase() == 'location') return location();
    if(command.toLowerCase() == 'balance') return balance();
    if(command.toLowerCase() == 'inventory') return inventory();
    if(command.toLowerCase() == 'stats') return stats();
    if(command.toLowerCase() == 'alliances') return alliances();
    if(command.toLowerCase() == 'clear') return clear();
    
    socket.emit('action', actionObj);
  }

  function help(){
    const text = document.getElementById('text');
    
    text.innerText = text.innerText + `Use commands to navigate and interact with the game!
    Global commands:
    "location": Reminds you of your surroundings.
    "stats": List your current stats. (Health, strength, speed, etc.)
    "balance": Tells you how much money you have.
    "inventory": Shows you what items you own.
    "move {direction}": Moves you in a given direction. (North, South, East, West)
    "alliances": Lists your alliances.
    "eat {item}": Consume a food item to heal. Must have item in inventory
    "clear": Clears the output.
    NOTE: There are other location-specific commands that will be explained by other characters.\n\n`;
    
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
      
    text.innerText = `${text.innerText}Entered ${map[savedUser.game.location].name}.\n${map[savedUser.game.location].text}${addedMessage}\n\n`;
      
    scroll();
  }

  function balance(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Current balance: $${savedUser.game.money}\n\n`;
    
    scroll();
  }

  function stats(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Health: ${savedUser.game.health}/${savedUser.game.maxHealth}\nStrength: ${savedUser.game.damage}\nSpeed: ${savedUser.game.speed}\n\n`;
    
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
    
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}${textToDisplay}\n\n`;
    
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
    
    text.innerText = `${text.innerText}${textToDisplay}\n\n`;
    
    scroll();
  }

  function clear(){
    document.getElementById('text').innerText = '';
    scroll();
  }

  function updateGame(updateObj){
    savedUser = updateObj.user;
    
    if(updateObj.notify == true){
      location();
    }

    doScreenEffects(savedUser, updateObj.user);
  }

  function scroll(){
    const terminal = document.getElementById('terminal');
    terminal.scrollTop = terminal.scrollHeight;
  }

  function sendChat(){
    const input = document.getElementById('chatInput');
    const msg = input.value;
    
    if((msg.length < 1) || (msg.length > 199)) return;
  
    socket.emit('sendChat', msg);
    input.value = '';
  }
  
  function newChat(msgObj){
    const sender = msgObj.sender;
    const badgeColor = msgObj.badgeColor;
    
    let messages = document.getElementById('chat').children;
  
    while(document.getElementById('chat').offsetHeight > 390){
      messages[0].remove();
      messages = document.getElementById('chat').children;
    }
  
    let li = document.createElement('li')
    let badge = document.createElement('span')
    let msg = document.createElement('msg')
  
      
    badge.innerText = `${sender}: `;
    badge.style.color = msgObj.badgeColor;
  
    msg.innerText = msgObj.msg;
    li.appendChild(badge);
    li.appendChild(msg);
  
    document.getElementById('chat').appendChild(li);
  }
  
  document.getElementById('chatInput').addEventListener('keyup', function(event) {
    if(event.keyCode === 13){
      event.preventDefault();
      sendChat();
    }
  });

  function updateLeaderboard(leaderboard){
    if((leaderboard.length < 1) || (!leaderboard)) return;
    
    const places = document.getElementById('leaderboard').getElementsByTagName('li');
    
    for(let place in places){
      const player = leaderboard[place];
      if(player){
        places[place].innerText = `${+place + 1}: ${player.username} - $${formatNumber(player.money)}`;
      }
    }
  }

  function formatNumber(number){
    if(number){
      return(number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    } else {
      return(number);
    }
  }

  function capitalizeFirstLetter(word){
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  // Screen effects

  function doScreenEffects(oldSave, newSave){
    // Screen shake on damage
    if(oldSave.game.health > newSave.game.health) shakeElement(document.getElementById('text'), 300);
  }

  function shakeElement(element, duration){
    element.classList.add('shake');
    setTimeout(function(){
      element.classList.remove('shake');
    }, duration);
  }
})();