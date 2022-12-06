(() => {	
  socket = io();
  let map;
  let savedUser;

  fetch('https://ta.catr3kd.repl.co/map')
  .then((response) => response.json())
  .then((data) => {
  	map = data;
  });
  
  socket.on('loggedIn', function(user){
    document.getElementById('login').style.visibility = 'hidden';
    document.getElementById('content').style.visibility = 'visible';
    updateGame({"user": user, "notify": true});
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

  socket.on('kicked', function (){
    window.location.reload();
  });
  
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
    
    socket.emit('action', actionObj);
  }

  function help(){
    const text = document.getElementById('text');
    
    text.innerText = text.innerText + `Use commands to navigate and interact with the game!
    Global commands:
    "location" Reminds you of your surroundings.
    "stats": List your current stats. (Health, strength, speed, etc.)
    "balance" Tells you how much money you have.
    "inventory" Shows you what items you own.
    "move {direction}" Moves you in a given direction. (North, South, East, West)
    "alliances" Lists your alliances.
    NOTE: There are other location-specific commands that will be explained by other characters.\n\n`;
    
    scroll();
  }

  function location(){
    const text = document.getElementById('text');
      const location = map[savedUser.game.location];

      let addedMessage = '\n';

      Object.keys(location.neighbors).forEach(function(key){
        const neighbor = map[location.neighbors[key]];
        addedMessage +=`\n${key.charAt(0).toUpperCase() + key.slice(1)}: ${neighbor.name}`;
      });
    
      for(let enemyID in location.enemies){
        const enemy = location.enemies[enemyID];
        
        if(!(savedUser.game.defeatedEnemies.includes(enemy.name))) addedMessage += `\n${enemyID.charAt(0).toUpperCase() + enemyID.slice(1)} blocks travel to the ${enemy.blockedDirection}! ("fight ${enemyID}")`;
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
    const inventory = savedUser.game.alliances;
    let textToDisplay = '';

    if(inventory.length <= 0){
      textToDisplay = 'You have no alliances!';
    } else {
      textToDisplay = 'Your alliances:';
      for(let alliance of inventory){
        textToDisplay += `\n${alliance}`;
      }
    }
    
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}${textToDisplay}\n\n`;
    
    scroll();
  }

  function updateGame(updateObj){
    savedUser = updateObj.user;
    
    if(updateObj.notify == true){
      location();
    }
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
    console.log(msgObj)
    const sender = msgObj.sender;
    const badgeColor = msgObj.badgeColor;
    
    let messages = document.getElementById('chat').children;
  
    while(document.getElementById('chat').offsetHeight > 400){
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
})()