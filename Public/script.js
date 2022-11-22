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
    updateGame(user);
  });

  socket.on('gameUpdate', function(user){
    updateGame(user);
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
    if(command.toLowerCase() == 'location') return whereAmI();
    if(command.toLowerCase() == 'balance') return balance();
    
    socket.emit('action', actionObj);
  }

  function help(){
    const text = document.getElementById('text');
    
    text.innerText = text.innerText + `Use commands to navigate and interact with the game!
    Global commands:
    "location" Reminds you of your surroundings.
    "balance" Tells you how much money you have.
    "move {direction}" Moves you in a given direction. (North, South, East, West)
    "talk {name}" Interact with an NPC by name.
    \nLocation specific commands:
    "mine" Begin mining for gold. [Mineshaft]
    "buy {item}" Purchase an item from a vendor. [Near vendor]
    "inspect {item}" Get more information about a vendor's item. [Near vendor]\n\n`;
    
    scroll();
  }

  function whereAmI(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Entered ${map[savedUser.game.location].name}.\n${map[savedUser.game.location].text}\n\n`;
    
    scroll();
  }

  function balance(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Current balance: $${savedUser.game.money}\n\n`;
    
    scroll();
  }

  function updateGame(user){
    const text = document.getElementById('text');
    savedUser = user;
    
    text.innerText = `${text.innerText}Entered ${map[user.game.location].name}.\n${map[user.game.location].text}\n\n`;
    
    scroll();
  }

  function scroll(){
    const terminal = document.getElementById('terminal');
    terminal.scrollTop = terminal.scrollHeight;
  }
})()